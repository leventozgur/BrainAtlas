// SPDX-License-Identifier: MIT
import { access, stat, statfs } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { totalmem } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { SEMANTIC_DEFAULTS, saveConfig, setConfigValue } from '../../../packages/core/src/config/index.mjs';
import { createOllamaProvider, validateConfiguredProvider } from './provider.mjs';
import { markdownChunks } from './chunking.mjs';
import { updateSemanticIndex, readSemanticIndex, measureIndexFreshness, countPendingChunks } from './index-store.mjs';

const execFile = promisify(execFileCallback);
const names = ['preflight', 'ollama', 'server', 'model', 'index', 'probe', 'config'];
function argumentError() { return Object.assign(new Error('Invalid semanticSetup arguments.'), { code: 'E_ARGUMENT' }); }
function parse(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--yes') options.yes = true;
    else if (arg === '--dry-run') options.dry = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--mode' && ['semantic-primary', 'rrf'].includes(args[i + 1])) options.mode = args[++i];
    else throw argumentError();
  }
  return options;
}
async function executable(name, ctx) {
  const locations = (ctx.env.PATH ?? '').split(delimiter).filter(Boolean).map(dir => join(dir, name));
  if (name === 'ollama') locations.push('/opt/homebrew/bin/ollama', '/usr/local/bin/ollama', '/usr/bin/ollama', '/Applications/Ollama.app/Contents/Resources/ollama');
  for (const candidate of locations) {
    try { await (ctx.access ?? access)(candidate, constants.X_OK); return candidate; } catch { /* try next */ }
  }
  return null;
}
async function request(fetchImpl, url, options, timeoutMs, progress) {
  const controller = new AbortController(); let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')); }, timeoutMs); });
  try { return await Promise.race([fetchImpl(url, { ...options, signal: controller.signal }).then(async response => {
    if (!response?.ok) throw new Error('request failed');
    return options.method === 'POST' ? await consumePull(response, progress) : await response.json();
  }), timeout]); } finally { clearTimeout(timer); }
}
async function consumePull(response, progress) {
  if (!response.body) throw new Error('missing stream');
  const decoder = new TextDecoder(); let buffer = ''; let success = false; let last = 0;
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n'); buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      const item = JSON.parse(line); if (item.error) throw new Error('pull failed');
      if (item.status === 'success') success = true;
      if (Date.now() - last >= 2000) { progress?.(); last = Date.now(); }
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) { const item = JSON.parse(buffer); if (item.error) throw new Error('pull failed'); if (item.status === 'success') success = true; }
  if (!success) throw new Error('incomplete pull');
}
async function ask(question = 'Proceed with semantic setup (model download, if needed, is ~240 MB)? [y/N] ') {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try { return /^y(?:es)?$/iu.test((await rl.question(question)).trim()); }
  finally { rl.close(); }
}
export async function semanticSetup(args, ctx) {
  const options = parse(args); const retry = `brainatlas semanticSetup --yes${options.mode ? ` --mode ${options.mode}` : ''}`; const settings = { ...SEMANTIC_DEFAULTS, ...ctx.config.semantic };
  // Setup never transfers vault text to a remote service.
  validateConfiguredProvider({ ...settings, allowRemote: false });
  const isTTY = ctx.isTTY ?? Boolean(process.stdin.isTTY && process.stderr.isTTY);
  const dry = options.dry || (!options.yes && !isTTY);
  const steps = Object.fromEntries(names.map(name => [name, { status: 'skipped', reason: 'Not reached.' }]));
  const report = { dryRun: dry, mode: options.mode ?? settings.mode, steps, next: null };
  const set = (name, status, reason, extra = {}) => { steps[name] = { status, reason, ...extra }; };
  const finish = () => ({ exitCode: Object.values(steps).some(step => step.status === 'action-needed') ? 2 : 0,
    output: options.json ? JSON.stringify(report) : [...Object.entries(steps).map(([name, step]) => `${name}: ${step.status} — ${step.reason}${step.queryMs === undefined ? '' : ` (${step.queryMs} ms; ${step.pages} pages)`}`), ...(report.next ? [`Next: ${report.next}`] : [])].join('\n') });
  const stop = (name, reason, next) => { set(name, 'action-needed', reason); report.next = next; return finish(); };
  const progress = message => { if (!options.json) (ctx.progress ?? (text => process.stderr.write(`${text}\n`)))(message); };
  const vault = resolve(ctx.env.HOME ?? '.', ctx.config.vault.path); const corpusDir = join(vault, 'wiki');
  try {
    if (!['darwin', 'linux'].includes(ctx.platform ?? process.platform)) return stop('preflight', 'This platform is not supported by guided setup.', 'Use a supported macOS or Linux system, then run ' + retry);
    if (Number((ctx.nodeVersion ?? process.versions.node).split('.')[0]) < 20) return stop('preflight', 'Node.js 20 or newer is required.', 'Install Node.js 20 or newer, then run ' + retry);
    if (!(await (ctx.stat ?? stat)(vault)).isDirectory() || !(await (ctx.stat ?? stat)(corpusDir)).isDirectory()) throw new Error();
  } catch { return stop('preflight', 'Vault or wiki directory is missing.', 'Create the vault wiki directory, then run ' + retry); }
  const warnings = [];
  if ((ctx.totalmem ?? totalmem)() < 6 * 1024 ** 3) warnings.push('Less than 6 GB RAM.');
  try { const disk = await (ctx.statfs ?? statfs)(vault); if (Number(disk.bavail) * Number(disk.bsize) < 1024 ** 3) warnings.push('Less than 1 GB free disk space.'); } catch { warnings.push('Free disk space could not be checked.'); }
  set('preflight', 'ok', ['Vault and runtime available.', ...warnings].join(' '));
  const binary = await executable('ollama', ctx); const brew = (ctx.platform ?? process.platform) === 'darwin' && await executable('brew', ctx);
  if (!binary) return stop('ollama', 'Ollama is not installed.', brew ? 'brew install ollama' : 'Install Ollama from https://ollama.com/download, then run ' + retry);
  try { await (ctx.execFile ?? execFile)(binary, ['--version'], { timeout: 3000 }); }
  catch { return stop('ollama', 'Ollama version check failed.', 'Install or repair Ollama from https://ollama.com/download, then run ' + retry); }
  set('ollama', 'ok', 'Ollama is installed.');
  const fetchImpl = ctx.fetchImpl ?? globalThis.fetch; const base = settings.baseUrl.replace(/\/$/u, '');
  try { await request(fetchImpl, `${base}/api/version`, { method: 'GET' }, 3000); }
  catch { return stop('server', 'Ollama server is unavailable.', brew ? 'brew services start ollama' : 'ollama serve'); }
  set('server', 'ok', 'Ollama server is reachable.');
  let tags;
  try { tags = await request(fetchImpl, `${base}/api/tags`, { method: 'GET' }, 3000); if (!Array.isArray(tags.models)) throw new Error(); }
  catch { return stop('model', 'Could not inspect installed models.', 'Check the Ollama server, then run ' + retry); }
  const installed = tags.models.some(item => item.name === settings.model || item.model === settings.model || (!settings.model.includes(':') && (item.name === `${settings.model}:latest` || item.model === `${settings.model}:latest`)));
  if (installed) set('model', 'skipped', 'Configured model is already installed.');
  else {
    if (dry) return stop('model', 'Configured model needs a download of approximately 240 MB.', retry);
    if (!options.yes && !(await (ctx.prompt ?? ask)())) return stop('model', 'Model download was not approved.', retry);
    progress('Downloading configured model (~240 MB).');
    try { await request(fetchImpl, `${base}/api/pull`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: settings.model, stream: true }) }, ctx.pullTimeoutMs ?? 30 * 60 * 1000, () => progress('Model download in progress.')); }
    catch { return stop('model', 'Model download failed or timed out.', 'Check the Ollama server and disk space, then run ' + retry); }
    set('model', 'ok', 'Configured model downloaded.');
  }
  if (dry) { const provider = createOllamaProvider({ ...settings, fetchImpl }); const count = await countPendingChunks({ corpusDir, stateDir: ctx.paths.stateDir, provider, chunkMarkdown: markdownChunks }); set('index', 'skipped', `Index would embed ${count} chunks; duration depends on hardware.`); set('probe', 'skipped', 'Probe would run after indexing.'); set('config', 'skipped', 'Configuration would be enabled after verification.'); report.next = retry; return finish(); }
  // For an already installed model, interactive consent still covers index and config changes.
  if (installed && !options.yes && !(await (ctx.prompt ?? ask)())) return stop('index', 'Setup was not approved.', retry);
  const provider = createOllamaProvider({ ...settings, timeoutMs: settings.indexTimeoutMs, batchSize: settings.indexBatchSize, fetchImpl });
  const queryProvider = createOllamaProvider({ ...settings, fetchImpl });
  let lastTime = -Infinity, lastPercent = -10, warned = false, warnedHour = false;
  // A `\r` progress line stays open until something else is written; close it with a newline first.
  let lineOpen = false;
  const endLine = () => { if (lineOpen) { lineOpen = false; process.stderr.write('\n'); } };
  const emit = message => { endLine(); (ctx.progress ?? (text => process.stderr.write(`${text}\n`)))(message); };
  const confirm = question => { endLine(); return (ctx.prompt ?? ask)(question); };
  const onProgress = async info => {
    if (info.phase !== 'embed') return;
    const time = (ctx.now ?? Date.now)(); const percent = info.total ? Math.floor(info.done * 100 / info.total) : 100;
    if (time - lastTime >= (isTTY ? 1000 : 30000) || (!isTTY && percent >= lastPercent + 10)) {
      const message = `Index: ${info.done}/${info.total} chunks${info.etaMs === null ? '' : `, ETA ${Math.ceil(info.etaMs / 1000)}s`}`;
      if (isTTY && !ctx.progress) { process.stderr.write(`\r${message}   `); lineOpen = true; } else emit(message);
      lastTime = time; lastPercent = percent;
    }
    if (!warned && info.etaMs > 300000) {
      warned = true; emit(`Estimated remaining time: ${Math.ceil(info.etaMs / 60000)} minutes. Indexing uses CPU heavily; progress is saved and you can interrupt and resume with the same command.`);
      if (info.etaMs > 3600000) { warnedHour = true; emit('Warning: indexing may take more than an hour.'); }
      if (!options.yes && isTTY && !(await confirm('Continue indexing? [y/N] '))) throw Object.assign(new Error('Indexing declined.'), { code: 'E_SEMANTIC_DECLINED' });
    }
    if (!warnedHour && info.etaMs > 3600000) { warnedHour = true; emit('Warning: indexing may take more than an hour.'); }
  };
  let index;
  try {
    const previous = await readSemanticIndex(ctx.paths.stateDir);
    const freshness = previous && await measureIndexFreshness({ corpusDir, index: previous });
    if (previous && previous.providerFingerprint === provider.fingerprint && freshness.stale === 0 && freshness.missing === 0 && freshness.indexed === Object.keys(previous.fileHashes).length) {
      // Deletions require comparing the current file count as well.
      index = await updateSemanticIndex({ corpusDir, stateDir: ctx.paths.stateDir, provider, chunkMarkdown: markdownChunks, skipUnchangedWrite: true, indexBatchSize: settings.indexBatchSize, now: ctx.now, onProgress });
      set('index', index.createdAt === previous.createdAt ? 'skipped' : 'ok', 'Index is up to date.');
    } else { index = await updateSemanticIndex({ corpusDir, stateDir: ctx.paths.stateDir, provider, chunkMarkdown: markdownChunks, skipUnchangedWrite: true, indexBatchSize: settings.indexBatchSize, now: ctx.now, onProgress }); set('index', 'ok', 'Index built or updated.'); }
  } catch (error) {
    endLine();
    if (error?.code === 'E_SEMANTIC_DECLINED') return stop('index', 'Indexing was not approved; progress was saved.', retry);
    if (error?.code === 'E_SEMANTIC_BUSY') return stop('index', 'Another indexing operation is running.', retry);
    return stop('index', 'Indexing failed.', 'Check the vault, model and state directory, then run ' + retry);
  }
  endLine();
  try {
    if (!index.entries.length || index.providerFingerprint !== provider.fingerprint) throw new Error();
    const start = performance.now(); await queryProvider.embedQuery(index.entries[0].text.slice(0, 120));
    set('probe', 'ok', 'Embedding probe succeeded.', { queryMs: Math.round(performance.now() - start), pages: Object.keys(index.fileHashes).length });
  } catch { return stop('probe', 'Embedding verification failed or the index has no searchable pages.', 'Check the vault and model, then run ' + retry); }
  if (settings.enabled && (!options.mode || settings.mode === options.mode)) set('config', 'skipped', 'Semantic retrieval is already enabled.');
  else {
    try { let cfg = setConfigValue(ctx.config, 'semantic.enabled', true); if (options.mode) cfg = setConfigValue(cfg, 'semantic.mode', options.mode); await (ctx.saveConfig ?? saveConfig)(cfg, { paths: ctx.paths }); }
    catch { return stop('config', 'Configuration could not be saved.', 'Check configuration permissions, then run ' + retry); }
    set('config', 'ok', 'Semantic retrieval enabled.');
  }
  return finish();
}
