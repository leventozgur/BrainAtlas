// SPDX-License-Identifier: MIT
import { createHash } from 'node:crypto';
import { constants, realpathSync } from 'node:fs';
import { lstat, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { redact } from '../../core/src/safety/index.mjs';
import { resolvePaths, vaultId } from '../../core/src/paths/index.mjs';
import { SEMANTIC_DEFAULTS } from '../../core/src/config/index.mjs';
import { SEMANTIC_BUDGET_MS, semanticEntryUrl, semanticRequested } from './semantic.mjs';

const clients = new Set(['claude', 'codex', 'kiro', 'copilot', 'gemini']);
export const HOOK_PROCESS_DEADLINE_MS = 4700;
export const WARMUP_WAIT_MS = 2000;
const WARMUP_RATE_LIMIT_MS = 60000;
const REDACT_OUTPUT = { personal: true };
const events = new Set(['prompt', 'session-start', 'session-end']);
const hash = (s) => createHash('sha256').update(s).digest('hex');
const empty = (client) => (client === 'kiro' ? '' : '{}');
function envelope(client, event, context) {
  if (!context) return empty(client);
  if (client === 'kiro') return context;
  if (client === 'copilot') return JSON.stringify({ additionalContext: context });
  if (client === 'gemini') return JSON.stringify({ hookSpecificOutput: { additionalContext: context } });
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: event === 'session-start' ? 'SessionStart' : 'UserPromptSubmit',
      additionalContext: context,
    },
  });
}
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
  } catch {
    return null;
  } finally {
    await h?.close().catch(() => {});
  }
}
async function withoutRestrictedRecap(text, vault) {
  if (!text) return text;
  const kept = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('- ') || !line.endsWith(')')) {
      kept.push(line);
      continue;
    }
    let restricted = false;
    for (let i = line.indexOf('('); i >= 0 && !restricted; i = line.indexOf('(', i + 1))
      restricted = (await pageRestriction(vault, line.slice(i + 1, -1))) === true;
    if (!restricted) kept.push(line);
  }
  const heading = kept.indexOf('Recently changed pages:');
  if (heading >= 0 && !(kept[heading + 1] ?? '').startsWith('- ')) kept.splice(heading, 1);
  return kept.join('\n');
}
function packBlock(client, event, context, item, cap) {
  const fits = (text) => envelope(client, event, text).length <= cap;
  const marker = `${item.trust === 'weak' ? ' [unverified]' : ''}${item.synthesized === true ? ' [synthesized]' : ''}`;
  const marked = item.title + marker;
  const base = context + (context ? '\n\n' : '') + redact(`${marked} (${item.path})`, REDACT_OUTPUT);
  if (!fits(base)) return null;
  const snippet = redact(item.snippet, REDACT_OUTPUT);
  if (!snippet) return base;
  const text = (n) => {
    if (n >= snippet.length) return `${base}\n${snippet}`;
    let k = n;
    if (/[\uD800-\uDBFF]/u.test(snippet[k - 1])) k--;
    return `${base}\n${snippet.slice(0, k)}…`;
  };
  if (!fits(text(1))) return null;
  let lo = 1,
    hi = snippet.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(text(mid))) lo = mid;
    else hi = mid - 1;
  }
  return text(lo);
}
const PROGRESSIVE_BLOCKS = 2,
  PROGRESSIVE_POINTERS = 6,
  PROGRESSIVE_SNIPPET = 300;
const PROGRESSIVE_FIRST_SNIPPET = Infinity;
const POINTER_HEADER = 'More matches (open with wiki_read_page path + anchor):';
const clipSnippet = (item, cut, limit) =>
  limit < Infinity && typeof item.snippet === 'string' && item.snippet.length > limit
    ? { ...item, snippet: cut(item.snippet, limit - 1) + '…' }
    : item;
const withAnchor = (item) =>
  typeof item.anchor === 'string' && item.anchor ? { ...item, path: `${item.path}#${item.anchor}` } : item;
function pointerLine(item) {
  const heading = typeof item.heading === 'string' && item.heading ? ` › ${item.heading}` : '';
  const marker = `${item.trust === 'weak' ? ' [unverified]' : ''}${item.synthesized === true ? ' [synthesized]' : ''}`;
  const anchor = typeof item.anchor === 'string' && item.anchor ? `#${item.anchor}` : '';
  return `- ${item.title}${heading}${marker} (${item.path}${anchor})`;
}
function packProgressive(client, event, context, items, cap, cut) {
  const fits = (text) => envelope(client, event, text).length <= cap;
  const shown = [];
  let results = 0,
    header = false;
  for (const [index, item] of items.slice(0, PROGRESSIVE_BLOCKS).entries()) {
    const limit = index === 0 ? PROGRESSIVE_FIRST_SNIPPET : PROGRESSIVE_SNIPPET;
    const next = packBlock(client, event, context, withAnchor(clipSnippet(item, cut, limit)), cap);
    if (next === null) return { context, results, shown };
    context = next;
    results++;
    shown.push(item.path);
  }
  if (!results) return { context, results, shown };
  for (const item of items.slice(PROGRESSIVE_BLOCKS, PROGRESSIVE_BLOCKS + PROGRESSIVE_POINTERS)) {
    const line = redact(pointerLine(item), REDACT_OUTPUT);
    const next = header ? `${context}\n${line}` : `${context}\n\n${POINTER_HEADER}\n${line}`;
    if (!fits(next)) break;
    context = next;
    results++;
    header = true;
  }
  return { context, results, shown };
}
async function secureFile(file, flags) {
  const handle = await open(file, flags | (constants.O_NOFOLLOW || 0), 0o600);
  try {
    const st = await handle.stat();
    if (
      !st.isFile() ||
      st.nlink !== 1 ||
      (typeof process.getuid === 'function' && st.uid !== process.getuid()) ||
      st.mode & 0o077
    )
      throw new Error('Unsafe file');
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}
async function readState(file) {
  let h;
  try {
    h = await secureFile(file, constants.O_RDONLY);
    const v = JSON.parse(await h.readFile('utf8'));
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  } finally {
    await h?.close();
  }
}
async function writeState(file, values) {
  const h = await secureFile(file, constants.O_WRONLY | constants.O_CREAT);
  try {
    await h.truncate(0);
    await h.writeFile(JSON.stringify(values));
  } finally {
    await h.close();
  }
}
async function secureDirectory(dir, recursive = false) {
  try {
    await mkdir(dir, { recursive, mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const st = await lstat(dir);
  if (!st.isDirectory() || st.isSymbolicLink() || (typeof process.getuid === 'function' && st.uid !== process.getuid()))
    throw new Error('Unsafe directory');
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
    try {
      await h.writeFile(JSON.stringify(record) + '\n');
    } finally {
      await h.close();
    }
    // eslint-disable-next-line no-empty
  } catch {}
}
function semanticStep(config, env) {
  if (!semanticRequested(config)) return null;
  try {
    return {
      settings: { ...SEMANTIC_DEFAULTS, ...config.semantic },
      stateDir: resolvePaths({ env }).stateDir,
      budgetMs: SEMANTIC_BUDGET_MS,
      entryUrl: semanticEntryUrl(),
    };
  } catch {
    return null;
  }
}
async function warmupDue(stateDir, now) {
  if (!stateDir) return false;
  const file = join(stateDir, 'semantic-warmup.json');
  let previous;
  try {
    previous = await readFile(file, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') return false;
  }
  if (previous !== undefined) {
    let at = NaN;
    try {
      const stored = JSON.parse(previous)?.at;
      if (typeof stored === 'string') at = Date.parse(stored);
      // eslint-disable-next-line no-empty
    } catch {}
    if (Number.isFinite(at) && at <= now.getTime() && now.getTime() - at < WARMUP_RATE_LIMIT_MS) return false;
  }
  const tmp = `${file}.${process.pid}.${now.getTime()}.tmp`;
  try {
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    await writeFile(tmp, JSON.stringify({ at: now.toISOString() }), { flag: 'wx', mode: 0o600 });
    await rename(tmp, file);
    return true;
  } catch {
    await rm(tmp, { force: true }).catch(() => {});
    return false;
  }
}
function warmupTask(settings, stateDir, env, now) {
  return async (deadline = Date.now() + WARMUP_WAIT_MS) => {
    if (env.BRAINATLAS_OFFLINE === '1' || Date.now() >= deadline) return;
    if (!(await warmupDue(stateDir, now))) return;
    try {
      const module = await import(semanticEntryUrl());
      const timeoutMs = Math.floor(deadline - Date.now());
      if (timeoutMs <= 0) return;
      module.validateConfiguredProvider(settings);
      const provider = module.createOllamaProvider({ ...settings, timeoutMs });
      await provider.embed(['warm-up']);
      // eslint-disable-next-line no-empty
    } catch {}
  };
}
/**
 * @param {{stdout?:string,exitCode?:number,warmup?:(deadline:number)=>(void|Promise<void>)}} result
 * @param {number} started process start timestamp (`Date.now()`)
 * @param {(exitCode:number)=>void} done
 */
export function finishHookOutput(result, started, done) {
  const after = async () => {
    const warmup = result?.warmup;
    if (typeof warmup === 'function' && HOOK_PROCESS_DEADLINE_MS - (Date.now() - started) >= WARMUP_WAIT_MS) {
      const deadline = Date.now() + WARMUP_WAIT_MS;
      let cap;
      try {
        await Promise.race([
          Promise.resolve()
            .then(() => warmup(deadline))
            .catch(() => {}),
          new Promise((resolve) => {
            cap = setTimeout(resolve, WARMUP_WAIT_MS);
          }),
        ]);
        // eslint-disable-next-line no-empty
      } catch {
      } finally {
        clearTimeout(cap);
      }
    }
    done(result?.exitCode ?? 0);
  };
  if (!result?.stdout) void after();
  else process.stdout.write(result.stdout, after);
}
function shadowThreshold(retrieval) {
  const shadow = retrieval?.shadow;
  if (!shadow || typeof shadow !== 'object' || Array.isArray(shadow) || !hasOnlyKey(shadow, 'abstainThreshold'))
    return undefined;
  const value = shadow.abstainThreshold;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined;
}
function hasOnlyKey(object, key) {
  const keys = Object.keys(object);
  return keys.length === 1 && keys[0] === key;
}
function retrieve(options, query, searchOptions, remaining, semantic, shadow) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./worker.mjs', import.meta.url), {
      workerData: { options, query, searchOptions, semantic, shadowThreshold: shadow },
    });
    let done = false;
    const finish = (error, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      void worker.terminate();
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('deadline')), Math.max(0, remaining));
    worker.once('message', (value) => (value.error ? finish(new Error('search')) : finish(null, value)));
    worker.once('error', () => finish(new Error('search')));
    worker.once('exit', () => finish(new Error('search')));
  });
}
/** @param {{client?:string,event?:string,stdin?:string,env?:object,now?:Date,config?:any}} [input] @returns {Promise<{stdout:string,exitCode:number,warmup?:(deadline:number)=>Promise<void>}>} */
export async function runHook(input = {}) {
  const { client, event, stdin = '', env = {}, config = {}, now = new Date() } = input;
  if (!clients.has(client) || !events.has(event)) return { stdout: empty(client), exitCode: 2 };
  const start = Date.now();
  const deadline = Math.min(4700, Math.max(1, config.hooks?.deadlineMs ?? 4700));
  const mode = ['normal', 'economic', 'manual'].includes(config.hooks?.mode) ? config.hooks.mode : 'normal';
  let stateDir = config.stateDir || config.paths?.stateDir;
  if (!stateDir && config.vault?.path) {
    try {
      stateDir = join(resolvePaths({ env }).stateDir, vaultId(config.vault.path));
      // eslint-disable-next-line no-empty
    } catch {}
  }
  let session = '',
    context = '',
    results = 0,
    outcome = 'empty',
    semanticState,
    shadowState,
    warmup;
  try {
    let data = {};
    if (stdin.trim()) {
      data = JSON.parse(stdin);
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('input');
    }
    session = typeof (data.session_id ?? data.sessionId) === 'string' ? (data.session_id ?? data.sessionId) : '';
    const prompt = client === 'kiro' && typeof env.USER_PROMPT === 'string' ? env.USER_PROMPT : data.prompt;
    if (
      event === 'session-end' ||
      (client === 'copilot' && event === 'prompt') ||
      (event === 'session-start' && !['claude', 'copilot', 'gemini'].includes(client))
      // eslint-disable-next-line no-empty
    ) {
    } else if (event === 'session-start') {
      const geminiStartup = client !== 'gemini' || ['startup', 'resume', 'clear'].includes(data.source);
      if (stateDir && geminiStartup) {
        let handoff = '';
        try {
          handoff = await readFile(join(stateDir, 'handoff.md'), 'utf8');
          // eslint-disable-next-line no-empty
        } catch {}
        if (handoff.trim()) context = handoff;
        else if (mode !== 'manual' && config.vault?.path) {
          try {
            const { buildRecap } = await import('./recap.mjs');
            context = await withoutRestrictedRecap(
              await buildRecap({ vaultPath: config.vault.path, stateDir, now }),
              config.vault.path
            );
          } catch {
            context = '';
          }
        }
        const step = semanticStep(config, env);
        if (step) warmup = warmupTask(step.settings, stateDir, env, now);
      }
    } else if (typeof prompt === 'string' && prompt.trim() && stateDir && config.vault?.path) {
      const trigger = /(^|\s)(?:\/sb|@sb)(?=\s|$)/i.test(prompt);
      const query = prompt.replace(/(^|\s)(?:\/sb|@sb)(?=\s|$)/gi, '$1').trim();
      const knowledge =
        /\?|\b(?:what|why|how|where|when|which|who|explain|remember|knowledge|decision|nasıl|nedir|neden|hangi|nerede)\b/iu.test(
          query
        );
      if (query && (mode === 'normal' || trigger || (mode === 'economic' && knowledge))) {
        const { searchScope, isExcludedPath, prefixKeepingPairs } = await import('../../core/src/retrieval/index.mjs');
        const scope = searchScope(config.vault.path, config.retrieval?.exclude);
        const dir = await stateSubdirectory(stateDir, 'hooks');
        const file = join(dir, `${client}-${hash(session)}.json`);
        const seen = session ? await readState(file) : [];
        const hit = await retrieve(
          { vaultDir: scope.root, stateDir, now, exclude: scope.exclude },
          query,
          { limit: 20, abstainThreshold: config.retrieval?.abstainThreshold ?? 0 },
          deadline - (Date.now() - start),
          semanticStep(config, env),
          shadowThreshold(config.retrieval)
        );
        const found = hit.results
          .filter((item) => !isExcludedPath(item.path, scope.exclude))
          .map((item) => ({ ...item, path: scope.prefix + item.path }));
        semanticState = hit.semantic;
        shadowState = hit.shadow;
        if (semanticState === 'fallback:deadline') {
          const step = semanticStep(config, env);
          if (step) warmup = warmupTask(step.settings, stateDir, env, now);
        }
        if (Date.now() - start >= deadline) throw new Error('deadline');
        const unseen = found.filter((item) => !seen.includes(item.path));
        const fresh = [];
        for (const item of unseen) {
          if (item.inject === 'never') continue;
          if (hit.semantic !== undefined && (await pageRestriction(config.vault.path, item.path)) !== false) continue;
          fresh.push(item);
        }
        const cap = Math.min(
          client === 'codex' ? 1400 : mode === 'economic' ? 1500 : 4002,
          config.retrieval?.budgetChars ?? 4002
        );
        if (config.hooks?.disclosure === 'progressive') {
          const packed = packProgressive(client, event, context, fresh, cap, prefixKeepingPairs);
          context = packed.context;
          results = packed.results;
          seen.push(...packed.shown);
        } else {
          for (const item of fresh) {
            const next = packBlock(client, event, context, item, cap);
            if (next === null) break;
            context = next;
            results++;
            seen.push(item.path);
          }
        }
        if (session && results) await writeState(file, seen);
      }
    }
    context = redact(context, REDACT_OUTPUT);
    const limit = client === 'codex' ? 1400 : mode === 'economic' ? 1500 : 4002;
    while (context && envelope(client, event, context).length > limit)
      context = context.slice(0, Math.max(0, context.length - (envelope(client, event, context).length - limit)));
    if (Date.now() - start >= deadline) {
      context = '';
      results = 0;
      outcome = 'deadline';
    } else if (context) outcome = 'ok';
  } catch (error) {
    context = '';
    results = 0;
    outcome = error.message === 'deadline' ? 'deadline' : 'error';
  }
  await metric(stateDir, {
    ts: now.toISOString(),
    client,
    event,
    mode,
    durationMs: Date.now() - start,
    chars: context.length,
    results,
    outcome,
    session: hash(session).slice(0, 16),
    ...(semanticState ? { semantic: semanticState } : {}),
    ...(shadowState ? { shadow: shadowState } : {}),
  });
  return { stdout: envelope(client, event, context), exitCode: 0, ...(warmup ? { warmup } : {}) };
}
export function buildHookCommand({ nodePath, shimPath, client, event, paths }) {
  const version = process.versions.node.split('.').map(Number);
  const supported =
    process.allowedNodeEnvironmentFlags.has('--permission') &&
    (version[0] > 22 || (version[0] === 22 && version[1] >= 13));
  const args = [nodePath];
  const canonical = (value) => {
    try {
      return realpathSync(value);
    } catch {
      return value;
    }
  };
  if (supported) {
    let defaultConfig;
    try {
      defaultConfig = resolvePaths({ env: process.env }).configFile;
      // eslint-disable-next-line no-empty
    } catch {}
    let yamlDir;
    try {
      yamlDir = dirname(createRequire(import.meta.url).resolve('yaml/package.json'));
      // eslint-disable-next-line no-empty
    } catch {}
    let semanticIndexDir;
    try {
      semanticIndexDir = join(resolvePaths({ env: process.env }).stateDir, 'semantic');
      // eslint-disable-next-line no-empty
    } catch {}
    const reads = [
      paths.vault,
      paths.state,
      paths.release,
      paths.configFile,
      process.env.BRAINATLAS_CONFIG,
      defaultConfig,
      yamlDir,
      dirname(nodePath),
      shimPath,
      semanticIndexDir,
    ].filter(Boolean);
    args.push(
      '--permission',
      ...[...new Set(reads.flatMap((value) => [value, canonical(value)]))].map((value) => `--allow-fs-read=${value}`),
      ...[...new Set([paths.state, canonical(paths.state)])].map((value) => `--allow-fs-write=${value}`),
      '--allow-worker'
    );
  }
  args.push(shimPath, client, event);
  return args;
}
