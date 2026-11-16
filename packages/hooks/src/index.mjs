// SPDX-License-Identifier: MIT
import { createHash } from 'node:crypto';
import { constants, realpathSync } from 'node:fs';
import { lstat, mkdir, open, readFile } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { redact } from '../../core/src/safety/index.mjs';
import { resolvePaths, vaultId } from '../../core/src/paths/index.mjs';
import { SEMANTIC_DEFAULTS } from '../../core/src/config/index.mjs';
import { SEMANTIC_BUDGET_MS, semanticEntryUrl, semanticRequested } from './semantic.mjs';

const clients = new Set(['claude', 'codex', 'kiro', 'copilot', 'gemini']);
// BA-26: hook output also redacts e-mail addresses and TR phone numbers (contact data is kept in pages, not in injected context).
const REDACT_OUTPUT = {personal: true};
const events = new Set(['prompt', 'session-start', 'session-end']);
const hash = s => createHash('sha256').update(s).digest('hex');
const empty = client => client === 'kiro' ? '' : '{}';
function envelope(client, event, context) {
  if (!context) return empty(client);
  if (client === 'kiro') return context;
  if (client === 'copilot') return JSON.stringify({additionalContext: context});
  if (client === 'gemini') return JSON.stringify({hookSpecificOutput:{additionalContext:context}});
  return JSON.stringify({hookSpecificOutput:{hookEventName:event === 'session-start' ? 'SessionStart' : 'UserPromptSubmit',additionalContext:context}});
}
// BA-26: a restricted page (sensitivity personal or inject never) is never injected. The sentinel is read from the first 4 KB of
// the file, so it also works for results that come from the semantic step (which carries no index field).
// Returns true (restricted), false (readable and unrestricted) or null (unreadable or outside the vault).
const RESTRICTED_HEAD = /^[ \t]*(?:sensitivity[ \t]*:[^\n]*\bpersonal\b|inject[ \t]*:[^\n]*\bnever\b)/im;
async function pageRestriction(vault, rel) {
  let h;
  try {
    const vaultReal = realpathSync.native(vault);
    const file = join(vaultReal, rel);
    if (!realpathSync.native(file).startsWith(vaultReal + sep)) return null;
    h = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    if (!(await h.stat()).isFile()) return null;
    const buf = Buffer.alloc(4096);
    const { bytesRead } = await h.read(buf, 0, 4096, 0);
    return RESTRICTED_HEAD.test(buf.subarray(0, bytesRead).toString('utf8'));
  } catch { return null; }
  finally { await h?.close().catch(() => {}); }
}
// Drops recap page lines whose page is restricted. A candidate path is the text inside any parenthesis pair at the end of a line;
// a candidate that is not a readable page is not a page and is kept as it is.
async function withoutRestrictedRecap(text, vault) {
  if (!text) return text;
  const kept = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('- ') || !line.endsWith(')')) { kept.push(line); continue; }
    let restricted = false;
    for (let i = line.indexOf('('); i >= 0 && !restricted; i = line.indexOf('(', i + 1)) restricted = (await pageRestriction(vault, line.slice(i + 1, -1))) === true;
    if (!restricted) kept.push(line);
  }
  // A recap card whose page lines were all removed must not keep an empty list heading.
  const heading = kept.indexOf('Recently changed pages:');
  if (heading >= 0 && !(kept[heading + 1] ?? '').startsWith('- ')) kept.splice(heading, 1);
  return kept.join('\n');
}
// Packs one retrieved result after the current context. The "Title (path)" line must fit whole or the block is
// refused (null, and the caller stops). The excerpt is cut to the room left and ends with an ellipsis.
function packBlock(client, event, context, item, cap) {
  const fits = text => envelope(client,event,text).length <= cap;
  // Weak (proposed or disputed) pages get a short marker before the path; the line still ends with the path.
  const marked = item.trust === 'weak' ? `${item.title} [unverified]` : item.title;
  const base = context + (context ? '\n\n' : '') + redact(`${marked} (${item.path})`, REDACT_OUTPUT);
  if (!fits(base)) return null;
  const snippet = redact(item.snippet, REDACT_OUTPUT);
  if (!snippet) return base;
  const text = n => {
    if (n >= snippet.length) return `${base}\n${snippet}`;
    let k = n;
    // Never split a surrogate pair.
    if (/[\uD800-\uDBFF]/u.test(snippet[k - 1])) k--;
    return `${base}\n${snippet.slice(0, k)}…`;
  };
  if (!fits(text(1))) return null;
  // The envelope length never shrinks as the excerpt grows, so the largest fitting length is a binary search.
  let lo = 1, hi = snippet.length;
  while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (fits(text(mid))) lo = mid; else hi = mid - 1; }
  return text(lo);
}
// BA-32: opt-in progressive packing. The first two results stay full blocks (their excerpt is clipped to 900 UTF-16 units,
// never inside a surrogate pair), the next up to six become one-line pointers after a fixed header. Nothing else changes:
// selection, dedup, restriction filtering, redaction and the cap are those of `full`. No page is read here.
const PROGRESSIVE_BLOCKS = 2, PROGRESSIVE_POINTERS = 6, PROGRESSIVE_SNIPPET = 900;
const POINTER_HEADER = 'More matches (open with wiki_read_page path + anchor):';
// `cut` is the core's prefixKeepingPairs, imported lazily with the search scope so the full path stays lazy.
const clipSnippet = (item, cut) => typeof item.snippet === 'string' && item.snippet.length > PROGRESSIVE_SNIPPET
  ? {...item, snippet: cut(item.snippet, PROGRESSIVE_SNIPPET - 1) + '…'} : item;
const withAnchor = item => typeof item.anchor === 'string' && item.anchor ? {...item, path: `${item.path}#${item.anchor}`} : item;
// `- Title › Heading [unverified] (path#anchor)`; heading, marker and anchor appear only when they exist.
function pointerLine(item) {
  const heading = typeof item.heading === 'string' && item.heading ? ` › ${item.heading}` : '';
  const marker = item.trust === 'weak' ? ' [unverified]' : '';
  const anchor = typeof item.anchor === 'string' && item.anchor ? `#${item.anchor}` : '';
  return `- ${item.title}${heading}${marker} (${item.path}${anchor})`;
}
/** Packs `items` progressively; returns the new context, the number of injected results and the full-block paths. */
function packProgressive(client, event, context, items, cap, cut) {
  const fits = text => envelope(client,event,text).length <= cap;
  const shown = [];
  let results = 0, header = false;
  for (const item of items.slice(0, PROGRESSIVE_BLOCKS)) {
    const next = packBlock(client, event, context, withAnchor(clipSnippet(item, cut)), cap);
    if (next === null) return {context, results, shown};
    context = next; results++; shown.push(item.path);
  }
  // Pointers are written only after at least one full block.
  if (!results) return {context, results, shown};
  for (const item of items.slice(PROGRESSIVE_BLOCKS, PROGRESSIVE_BLOCKS + PROGRESSIVE_POINTERS)) {
    const line = redact(pointerLine(item), REDACT_OUTPUT);
    const next = header ? `${context}\n${line}` : `${context}\n\n${POINTER_HEADER}\n${line}`;
    if (!fits(next)) break;
    context = next; results++; header = true;
  }
  return {context, results, shown};
}
// Open the inode itself without following links; check its identity and permissions before use.
async function secureFile(file, flags) {
  const handle = await open(file, flags | (constants.O_NOFOLLOW || 0), 0o600);
  try {
    const st = await handle.stat();
    if (!st.isFile() || st.nlink !== 1 || (typeof process.getuid === 'function' && st.uid !== process.getuid()) || (st.mode & 0o077)) throw new Error('Unsafe file');
    return handle;
  } catch (error) { await handle.close(); throw error; }
}
async function readState(file) {
  let h;
  try { h = await secureFile(file, constants.O_RDONLY); const v = JSON.parse(await h.readFile('utf8')); return Array.isArray(v) ? v.filter(x => typeof x === 'string') : []; }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  finally { await h?.close(); }
}
async function writeState(file, values) {
  const h = await secureFile(file, constants.O_WRONLY | constants.O_CREAT);
  try { await h.truncate(0); await h.writeFile(JSON.stringify(values)); } finally { await h.close(); }
}
async function secureDirectory(dir, recursive = false) {
  try { await mkdir(dir, {recursive, mode:0o700}); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const st = await lstat(dir);
  if (!st.isDirectory() || st.isSymbolicLink() || (typeof process.getuid === 'function' && st.uid !== process.getuid())) throw new Error('Unsafe directory');
}
async function stateSubdirectory(stateDir, name) {
  await secureDirectory(stateDir, true);
  const dir = join(stateDir, name);
  await secureDirectory(dir);
  return dir;
}
async function metric(stateDir, record) {
  if (!stateDir) return;
  try {
    const dir = await stateSubdirectory(stateDir, 'metrics');
    const h = await secureFile(join(dir, 'hooks.jsonl'), constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND);
    try { await h.writeFile(JSON.stringify(record) + '\n'); } finally { await h.close(); }
  } catch { /* Metrics never affect the hook. */ }
}
// Settings for the semantic step, or null when the hook must not touch the semantic module at all (Lite, opt-out, no HOME).
function semanticStep(config, env) {
  if (!semanticRequested(config)) return null;
  try { return {settings:{...SEMANTIC_DEFAULTS, ...config.semantic}, stateDir:resolvePaths({env}).stateDir, budgetMs:SEMANTIC_BUDGET_MS, entryUrl:semanticEntryUrl()}; }
  catch { return null; }
}
// BA-28: an opt-in shadow threshold from `retrieval.shadow`. Absent or invalid means the shadow search does not run.
function shadowThreshold(retrieval) {
  const shadow = retrieval?.shadow;
  if (!shadow || typeof shadow !== 'object' || Array.isArray(shadow) || !hasOnlyKey(shadow, 'abstainThreshold')) return undefined;
  const value = shadow.abstainThreshold;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined;
}
function hasOnlyKey(object, key) {
  const keys = Object.keys(object);
  return keys.length === 1 && keys[0] === key;
}
// Resolves `{results, shadow?, semantic?}`; `shadow` is present only when the shadow search ran and succeeded.
function retrieve(options, query, searchOptions, remaining, semantic, shadow) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./worker.mjs', import.meta.url), {workerData:{options,query,searchOptions,semantic,shadowThreshold:shadow}});
    let done = false;
    const finish = (error, value) => { if (done) return; done = true; clearTimeout(timer); void worker.terminate(); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => finish(new Error('deadline')), Math.max(0, remaining));
    worker.once('message', value => value.error ? finish(new Error('search')) : finish(null, value));
    worker.once('error', () => finish(new Error('search')));
    worker.once('exit', () => finish(new Error('search')));
  });
}
/** @param {{client:string,event:string,stdin:string,env:object,now:Date,config:object}} input @returns {Promise<{stdout:string,exitCode:number}>} */
export async function runHook(input = {}) {
  const {client, event, stdin = '', env = {}, config = {}, now = new Date()} = input;
  if (!clients.has(client) || !events.has(event)) return {stdout:empty(client),exitCode:2};
  const start = Date.now(); const deadline = Math.min(4700, Math.max(1, config.hooks?.deadlineMs ?? 4700));
  const mode = ['normal','economic','manual'].includes(config.hooks?.mode) ? config.hooks.mode : 'normal';
  let stateDir = config.stateDir || config.paths?.stateDir;
  if (!stateDir && config.vault?.path) { try { stateDir = join(resolvePaths({env}).stateDir, vaultId(config.vault.path)); } catch {} }
  let session = '', context = '', results = 0, outcome = 'empty', semanticState, shadowState;
  try {
    let data = {};
    if (stdin.trim()) { data = JSON.parse(stdin); if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('input'); }
    session = typeof (data.session_id ?? data.sessionId) === 'string' ? (data.session_id ?? data.sessionId) : '';
    const prompt = client === 'kiro' && typeof env.USER_PROMPT === 'string' ? env.USER_PROMPT : data.prompt;
    if (event === 'session-end' || (client === 'copilot' && event === 'prompt') || (event === 'session-start' && !['claude','copilot','gemini'].includes(client))) { /* unsupported */ }
    else if (event === 'session-start') {
      const geminiStartup = client !== 'gemini' || ['startup','resume','clear'].includes(data.source);
      if (stateDir && geminiStartup) {
        let handoff = '';
        try { handoff = await readFile(join(stateDir, 'handoff.md'), 'utf8'); } catch {}
        // An explicit handoff card wins; otherwise build the bounded recap (never in manual mode).
        // The recap module loads lazily so prompt hooks never pay for it; a load failure means an empty card.
        if (handoff.trim()) context = handoff;
        else if (mode !== 'manual' && config.vault?.path) {
          try { const { buildRecap } = await import('./recap.mjs'); context = await withoutRestrictedRecap(await buildRecap({vaultPath:config.vault.path,stateDir,now}), config.vault.path); }
          catch { context = ''; }
        }
      }
    } else if (typeof prompt === 'string' && prompt.trim() && stateDir && config.vault?.path) {
      const trigger = /(^|\s)(?:\/sb|@sb)(?=\s|$)/i.test(prompt);
      const query = prompt.replace(/(^|\s)(?:\/sb|@sb)(?=\s|$)/gi, '$1').trim();
      const knowledge = /\?|\b(?:what|why|how|where|when|which|who|explain|remember|knowledge|decision|nasıl|nedir|neden|hangi|nerede)\b/iu.test(query);
      if (query && (mode === 'normal' || trigger || (mode === 'economic' && knowledge))) {
        // BA-29: the same search scope as the MCP server (wiki root when present) and its root-level exclusions.
        const { searchScope, isExcludedPath, prefixKeepingPairs } = await import('../../core/src/retrieval/index.mjs');
        const scope = searchScope(config.vault.path, config.retrieval?.exclude);
        const dir = await stateSubdirectory(stateDir, 'hooks');
        const file = join(dir, `${client}-${hash(session)}.json`);
        const seen = session ? await readState(file) : [];
        // No cumulative snippet budget here: the hook packs every result itself under its own cap.
        const hit = await retrieve({vaultDir:scope.root,stateDir,now,exclude:scope.exclude}, query, {limit:20,abstainThreshold:config.retrieval?.abstainThreshold ?? 0}, deadline - (Date.now()-start), semanticStep(config, env), shadowThreshold(config.retrieval));
        // Paths leave the hook vault-relative, as before (`wiki/x.md`); only the set of searched pages changed.
        // The semantic step can name excluded pages (its entries come from the whole snapshot), so the same rule filters here.
        const found = hit.results.filter(item => !isExcludedPath(item.path, scope.exclude)).map(item => ({...item, path: scope.prefix + item.path})); semanticState = hit.semantic; shadowState = hit.shadow;
        if (Date.now()-start >= deadline) throw new Error('deadline');
        const unseen = found.filter(item => !seen.includes(item.path));
        // BA-26: restricted results are removed before packing, so they are never injected and never marked as shown.
        // The index field covers lexical results; once the semantic step has run, every result is also checked on disk.
        const fresh = [];
        for (const item of unseen) {
          if (item.inject === 'never') continue;
          if (hit.semantic !== undefined && (await pageRestriction(config.vault.path, item.path)) !== false) continue;
          fresh.push(item);
        }
        const cap = Math.min(client === 'codex' ? 1400 : mode === 'economic' ? 1500 : 4002, config.retrieval?.budgetChars ?? 4002);
        // BA-32: progressive packing is opt-in; without it the loop below is byte-identical to before.
        if (config.hooks?.disclosure === 'progressive') {
          const packed = packProgressive(client, event, context, fresh, cap, prefixKeepingPairs);
          context = packed.context; results = packed.results; seen.push(...packed.shown);
        } else {
          for (const item of fresh) {
            const next = packBlock(client, event, context, item, cap);
            if (next === null) break;
            context = next; results++; seen.push(item.path);
          }
        }
        if (session && results) await writeState(file, seen);
      }
    }
    context = redact(context, REDACT_OUTPUT);
    const limit = client === 'codex' ? 1400 : mode === 'economic' ? 1500 : 4002;
    while (context && envelope(client,event,context).length > limit) context = context.slice(0, Math.max(0, context.length - (envelope(client,event,context).length - limit)));
    if (Date.now()-start >= deadline) { context = ''; results = 0; outcome = 'deadline'; }
    else if (context) outcome = 'ok';
  } catch (error) { context = ''; results = 0; outcome = error.message === 'deadline' ? 'deadline' : 'error'; }
  // The `semantic` field appears only when the semantic step ran or was attempted; it never carries query or page text.
  // BA-28: the `shadow` field appears only when a valid shadow threshold was configured and its search succeeded.
  await metric(stateDir, {ts:now.toISOString(),client,event,mode,durationMs:Date.now()-start,chars:context.length,results,outcome,session:hash(session).slice(0,16),...(semanticState ? {semantic:semanticState} : {}),...(shadowState ? {shadow:shadowState} : {})});
  return {stdout:envelope(client,event,context),exitCode:0};
}
/** Build the node command used by client hook configuration. */
export function buildHookCommand({nodePath, shimPath, client, event, paths}) {
  const version = process.versions.node.split('.').map(Number);
  const supported = process.allowedNodeEnvironmentFlags.has('--permission') && (version[0] > 22 || (version[0] === 22 && version[1] >= 13));
  const args = [nodePath];
  const canonical = value => { try { return realpathSync(value); } catch { return value; } };
  if (supported) {
    let defaultConfig;
    try { defaultConfig = resolvePaths({env:process.env}).configFile; } catch {}
    let yamlDir;
    try { yamlDir = dirname(createRequire(import.meta.url).resolve('yaml/package.json')); } catch {}
    // The global semantic index (read-only) lives beside the per-vault state directories.
    let semanticIndexDir;
    try { semanticIndexDir = join(resolvePaths({env:process.env}).stateDir, 'semantic'); } catch {}
    const reads = [paths.vault, paths.state, paths.release, paths.configFile, process.env.BRAINATLAS_CONFIG, defaultConfig, yamlDir, dirname(nodePath), shimPath, semanticIndexDir].filter(Boolean);
    // Retrieval runs in a worker so its deadline can interrupt synchronous search.
    args.push('--permission', ...[...new Set(reads.flatMap(value => [value, canonical(value)]))].map(value => `--allow-fs-read=${value}`), ...[...new Set([paths.state, canonical(paths.state)])].map(value => `--allow-fs-write=${value}`), '--allow-worker');
  }
  args.push(shimPath, client, event); return args;
}
