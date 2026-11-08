// SPDX-License-Identifier: MIT
import { createHash } from 'node:crypto';
import { constants, realpathSync } from 'node:fs';
import { lstat, mkdir, open, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { redact } from '../../core/src/safety/index.mjs';
import { resolvePaths, vaultId } from '../../core/src/paths/index.mjs';

const clients = new Set(['claude', 'codex', 'kiro', 'copilot', 'gemini']);
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
function retrieve(options, query, searchOptions, remaining) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./worker.mjs', import.meta.url), {workerData:{options,query,searchOptions}});
    let done = false;
    const finish = (error, value) => { if (done) return; done = true; clearTimeout(timer); void worker.terminate(); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => finish(new Error('deadline')), Math.max(0, remaining));
    worker.once('message', value => value.error ? finish(new Error('search')) : finish(null, value.results));
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
  let session = '', context = '', results = 0, outcome = 'empty';
  try {
    let data = {};
    if (stdin.trim()) { data = JSON.parse(stdin); if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('input'); }
    session = typeof (data.session_id ?? data.sessionId) === 'string' ? (data.session_id ?? data.sessionId) : '';
    const prompt = client === 'kiro' && typeof env.USER_PROMPT === 'string' ? env.USER_PROMPT : data.prompt;
    if (event === 'session-end' || (client === 'copilot' && event === 'prompt') || (event === 'session-start' && !['claude','copilot'].includes(client))) { /* unsupported */ }
    else if (event === 'session-start') {
      if (stateDir) { try { context = await readFile(join(stateDir, 'handoff.md'), 'utf8'); } catch {} }
    } else if (typeof prompt === 'string' && prompt.trim() && stateDir && config.vault?.path) {
      const trigger = /(^|\s)(?:\/sb|@sb)(?=\s|$)/i.test(prompt);
      const query = prompt.replace(/(^|\s)(?:\/sb|@sb)(?=\s|$)/gi, '$1').trim();
      const knowledge = /\?|\b(?:what|why|how|where|when|which|who|explain|remember|knowledge|decision|nasıl|nedir|neden|hangi|nerede)\b/iu.test(query);
      if (query && (mode === 'normal' || trigger || (mode === 'economic' && knowledge))) {
        const dir = await stateSubdirectory(stateDir, 'hooks');
        const file = join(dir, `${client}-${hash(session)}.json`);
        const seen = session ? await readState(file) : [];
        const found = await retrieve({vaultDir:config.vault.path,stateDir,now}, query, {limit:20,budgetChars:4002,abstainThreshold:config.retrieval?.abstainThreshold ?? 0}, deadline - (Date.now()-start));
        if (Date.now()-start >= deadline) throw new Error('deadline');
        const fresh = found.filter(item => !seen.includes(item.path));
        const cap = Math.min(client === 'codex' ? 1400 : mode === 'economic' ? 1500 : 4002, config.retrieval?.budgetChars ?? 4002);
        // Leave room for JSON escaping and the envelope itself.
        for (const item of fresh) {
          const piece = `${context ? '\n\n' : ''}${item.title} (${item.path})\n${item.snippet}`;
          let candidate = redact(context + piece);
          while (candidate.length > context.length && envelope(client,event,candidate).length > cap) candidate = candidate.slice(0, Math.max(context.length, candidate.length - (envelope(client,event,candidate).length - cap)));
          if (candidate.length <= context.length) break;
          context = candidate; results++; seen.push(item.path);
        }
        if (session && results) await writeState(file, seen);
      }
    }
    context = redact(context);
    const limit = client === 'codex' ? 1400 : mode === 'economic' ? 1500 : 4002;
    while (context && envelope(client,event,context).length > limit) context = context.slice(0, Math.max(0, context.length - (envelope(client,event,context).length - limit)));
    if (Date.now()-start >= deadline) { context = ''; results = 0; outcome = 'deadline'; }
    else if (context) outcome = 'ok';
  } catch (error) { context = ''; results = 0; outcome = error.message === 'deadline' ? 'deadline' : 'error'; }
  await metric(stateDir, {ts:now.toISOString(),client,event,mode,durationMs:Date.now()-start,chars:context.length,results,outcome,session:hash(session).slice(0,16)});
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
    const reads = [paths.vault, paths.state, paths.release, paths.configFile, process.env.BRAINATLAS_CONFIG, defaultConfig, yamlDir, dirname(nodePath)].filter(Boolean);
    // Retrieval runs in a worker so its deadline can interrupt synchronous search.
    args.push('--permission', ...[...new Set(reads.flatMap(value => [value, canonical(value)]))].map(value => `--allow-fs-read=${value}`), ...[...new Set([paths.state, canonical(paths.state)])].map(value => `--allow-fs-write=${value}`), '--allow-worker');
  }
  args.push(shimPath, client, event); return args;
}
