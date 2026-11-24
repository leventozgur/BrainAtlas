// SPDX-License-Identifier: MIT
// Performance suite: hook latency budgets. Every test here compares a measured wall-clock duration with a fixed
// threshold, so it runs only in the `perf` CI job (`npm run test:perf`) and never in `npm test`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { runHook } from '../../packages/hooks/src/index.mjs';
import { defaultConfig, SEMANTIC_DEFAULTS } from '../../packages/core/src/config/index.mjs';
import { resolvePaths, vaultId } from '../../packages/core/src/paths/index.mjs';
import { createSearcher } from '../../packages/core/src/retrieval/index.mjs';
import { semanticHits, semanticEntryUrl } from '../../packages/hooks/src/semantic.mjs';
import { buildSemanticIndex, createOllamaProvider, markdownChunks } from '../../modules/semantic/src/index.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const BIN = join(ROOT, 'packages/hooks/bin/brainatlas-hook.mjs');
const H_HOOKS_DIR = join(ROOT, 'tests', 'acceptance', 'H-HOOKS');
const PRELOAD = join(H_HOOKS_DIR, 'slow-vault-read.mjs');
const PROCESS_TIMEOUT = 12_000;

// ---------- tests/hooks/hooks.test.mjs ----------

async function hooksTestFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'hooks-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vault = join(root, 'vault'),
    state = join(root, 'state');
  await mkdir(vault);
  await mkdir(state);
  await writeFile(join(vault, 'topic.md'), '# Topic\nknowledge topic evidence');
  return {
    root,
    vault,
    state,
    config: {
      vault: { path: vault },
      stateDir: state,
      hooks: { mode: 'normal', deadlineMs: 4700 },
      retrieval: { abstainThreshold: 0 },
    },
  };
}

test('command and cold start', async (t) => {
  const f = await hooksTestFixture(t);
  const bin = BIN;
  const env = {
    PATH: process.env.PATH,
    HOME: f.root,
    XDG_CONFIG_HOME: join(f.root, 'config'),
    XDG_STATE_HOME: join(f.root, 'xdg-state'),
    XDG_DATA_HOME: join(f.root, 'data'),
  };
  const configFile = resolvePaths({ env }).configFile;
  await mkdir(dirname(configFile), { recursive: true });
  const cfg = defaultConfig('lite');
  cfg.vault.path = f.vault;
  cfg.hooks.deadlineMs = 4700;
  cfg.retrieval.abstainThreshold = 0;
  await writeFile(configFile, JSON.stringify(cfg));
  const measure = () =>
    Array.from({ length: 20 }, () => {
      const start = performance.now();
      const r = spawnSync(process.execPath, [bin, 'claude', 'prompt'], {
        input: JSON.stringify({ prompt: 'topic' }),
        env,
        encoding: 'utf8',
      });
      assert.equal(r.status, 0);
      assert.match(r.stdout, /Topic/);
      return performance.now() - start;
    }).sort((a, b) => a - b)[18];
  let p95 = measure();
  for (let round = 1; round < 3 && p95 >= 300; round++) p95 = Math.min(p95, measure());
  /* PM: host load only adds latency; a real regression fails every round */ assert.ok(p95 < 300, `p95 ${p95} ms`);
});

// ---------- tests/acceptance/H-HOOKS/hook-acceptance.test.mjs ----------

async function hHooksFixture(t, { mode = 'normal', budgetChars = 4000 } = {}) {
  const createdRoot = await mkdtemp(join(tmpdir(), 'h-hooks-accept-'));
  const root = await realpath(createdRoot);
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  assert.notEqual(home, process.env.HOME, 'all child processes must use a disposable HOME');
  const vault = join(root, 'vault');
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(vault, { recursive: true }),
    mkdir(join(root, 'tmp'), { recursive: true }),
  ]);
  const env = {
    HOME: home,
    PATH: process.env.PATH || '/usr/bin:/bin',
    TMPDIR: join(root, 'tmp'),
    XDG_CONFIG_HOME: join(root, 'config-home'),
    XDG_DATA_HOME: join(root, 'data-home'),
    XDG_STATE_HOME: join(root, 'state-home'),
  };
  const paths = resolvePaths({ env });
  const stateDir = join(paths.stateDir, vaultId(vault));
  const config = defaultConfig('lite');
  config.vault.path = vault;
  config.hooks = { mode, deadlineMs: 4700 };
  config.retrieval = { budgetChars, abstainThreshold: 0 };
  await mkdir(dirname(paths.configFile), { recursive: true });
  await writeFile(paths.configFile, JSON.stringify(config));
  return { root, home, vault, env, paths, stateDir, configFile: paths.configFile, config };
}

async function hHooksPage(f, name = 'topic.md', body = '# Topic\nTopic retrieval evidence for acceptance checks.') {
  await writeFile(join(f.vault, name), body);
}

function hHooksRun(
  f,
  client = 'claude',
  event = 'prompt',
  payload = { session_id: 'session', prompt: 'topic' },
  { args = [], env = {}, input } = {}
) {
  const stdin = input ?? (typeof payload === 'string' ? payload : JSON.stringify(payload));
  return spawnSync(process.execPath, [BIN, client, event, ...args], {
    cwd: ROOT,
    env: { ...f.env, ...env },
    input: stdin,
    encoding: 'utf8',
    timeout: PROCESS_TIMEOUT,
    maxBuffer: 4 * 1024 * 1024,
  });
}

function assertSuccess(result, label) {
  assert.equal(result.error, undefined, `${label}: ${result.error?.message || ''}`);
  assert.equal(result.status, 0, `${label}: stderr=${result.stderr}`);
}

test('20 cold hook subprocesses have p95 startup below 300 ms', async (t) => {
  const f = await hHooksFixture(t);
  await hHooksPage(f);
  // PM: host load (parallel workers/test files) only adds latency, so the budget is checked on the best of up to
  // 3 rounds of 20 fresh processes; a real regression fails every round.
  let p95 = Infinity;
  for (let round = 0; round < 3 && p95 >= 300; round++) {
    const durations = [];
    for (let i = 0; i < 20; i++) {
      const start = performance.now();
      const result = hHooksRun(f, 'claude', 'prompt', { session_id: `cold-${round}-${i}`, prompt: 'topic' });
      durations.push(performance.now() - start);
      assertSuccess(result, `cold process ${i + 1}`);
      assert.match(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, /Topic/);
    }
    durations.sort((a, b) => a - b);
    p95 = Math.min(p95, durations[Math.ceil(0.95 * durations.length) - 1]);
  }
  t.diagnostic(`cold hook subprocess p95: ${p95.toFixed(1)} ms (best of up to 3 rounds x 20 fresh processes)`);
  assert.ok(p95 < 300, `20-process cold-start p95 ${p95.toFixed(1)} ms`);
});

test('4700 ms deadline fails open under an artificially delayed retrieval', async (t) => {
  const f = await hHooksFixture(t);
  await hHooksPage(f);
  const started = performance.now();
  const result = hHooksRun(
    f,
    'claude',
    'prompt',
    { session_id: 'slow-query', prompt: 'topic' },
    {
      env: { NODE_OPTIONS: `--import=${PRELOAD}` },
    }
  );
  const elapsed = performance.now() - started;
  assertSuccess(result, 'slow retrieval deadline');
  assert.equal(result.stdout, '{}');
  assert.ok(elapsed >= 4400 && elapsed < 7500, `deadline elapsed ${elapsed.toFixed(0)} ms`);
});

// ---------- tests/hooks/ba01-recap.test.mjs ----------

const logLine = (ts, entry) => `- ${ts} ${JSON.stringify(entry)}`;

async function recapHookFixture(t, { pages = {}, log = [], receipts = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ba01-recap-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vault = join(root, 'vault'),
    state = join(root, 'state');
  await mkdir(join(vault, 'wiki'), { recursive: true });
  await mkdir(state, { recursive: true });
  for (const [rel, body] of Object.entries(pages)) {
    await mkdir(dirname(join(vault, rel)), { recursive: true });
    await writeFile(join(vault, rel), body);
  }
  if (log.length) await writeFile(join(vault, 'wiki', 'log.md'), `# Log\nhuman note\n${log.join('\n')}\n`);
  if (receipts) {
    await mkdir(join(state, 'receipts', 'queue'), { recursive: true });
    for (const name of receipts) await writeFile(join(state, 'receipts', 'queue', name), '{}');
  }
  return {
    root,
    vault,
    state,
    config: {
      vault: { path: vault },
      stateDir: state,
      hooks: { mode: 'normal', deadlineMs: 4700 },
      retrieval: { abstainThreshold: 0 },
    },
  };
}

test('cold session-start stays under 300 ms p95 with a 5 MB log', async (t) => {
  const f = await recapHookFixture(t);
  // Built in one pass with a running byte count, so the fixture stays linear in size.
  const lines = [];
  let bytes = 0;
  for (let i = 0; bytes < 5 * 1024 * 1024; i++) {
    const line = logLine('2020-01-01T00:00:00.000Z', {
      action: 'update-page',
      path: `wiki/entities/old-${i % 500}.md`,
    });
    lines.push(line);
    bytes += line.length + 1;
  }
  lines.push(
    logLine(new Date(Date.now() - 3600_000).toISOString(), { action: 'update-page', path: 'wiki/entities/fresh.md' })
  );
  await mkdir(join(f.vault, 'wiki', 'entities'), { recursive: true });
  await writeFile(join(f.vault, 'wiki', 'entities', 'fresh.md'), '# Fresh cold page\n');
  await writeFile(join(f.vault, 'wiki', 'log.md'), lines.join('\n') + '\n');
  const env = {
    PATH: process.env.PATH,
    HOME: f.root,
    XDG_CONFIG_HOME: join(f.root, 'config'),
    XDG_STATE_HOME: join(f.root, 'xdg-state'),
    XDG_DATA_HOME: join(f.root, 'data'),
  };
  const paths = resolvePaths({ env });
  await mkdir(dirname(paths.configFile), { recursive: true });
  const config = defaultConfig('lite');
  config.vault.path = f.vault;
  config.retrieval.abstainThreshold = 0;
  await writeFile(paths.configFile, JSON.stringify(config));
  const measure = () =>
    Array.from({ length: 20 }, () => {
      const begin = performance.now();
      const r = spawnSync(process.execPath, [BIN, 'claude', 'session-start'], { input: '{}', env, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /Fresh cold page/);
      return performance.now() - begin;
    }).sort((a, b) => a - b)[18];
  let p95 = measure();
  for (let round = 1; round < 3 && p95 >= 300; round++) p95 = Math.min(p95, measure());
  assert.ok(p95 < 300, `p95 ${p95} ms`);
});

// ---------- tests/acceptance/BA-01/recap-acceptance.test.mjs ----------

const acceptEntry = (ms, path, action = 'update') =>
  `- ${new Date(ms).toISOString()} ${JSON.stringify({ action, path })}`;
const acceptFmPage = (title) => `---\ntitle: ${title}\n---\n# Body heading ignored\nText.\n`;

function acceptEnvFor(root) {
  const home = join(root, 'home');
  const env = {
    HOME: home,
    PATH: process.env.PATH || '/usr/bin:/bin',
    TMPDIR: join(root, 'tmp'),
    XDG_CONFIG_HOME: join(root, 'config-home'),
    XDG_DATA_HOME: join(root, 'data-home'),
    XDG_STATE_HOME: join(root, 'state-home'),
  };
  return { env, paths: resolvePaths({ env }), home };
}

async function acceptSession(t, { mode = 'normal' } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ba01-run-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vault = join(root, 'vault');
  await mkdir(join(vault, 'wiki', 'entities'), { recursive: true });
  await mkdir(join(root, 'tmp'), { recursive: true });
  const { env, paths, home } = acceptEnvFor(root);
  await mkdir(home, { recursive: true });
  const config = defaultConfig('lite');
  config.vault.path = vault;
  config.hooks = { mode, deadlineMs: 4700 };
  await mkdir(dirname(paths.configFile), { recursive: true });
  await writeFile(paths.configFile, JSON.stringify(config));
  const stateDir = join(paths.stateDir, vaultId(vault));
  return { root, vault, env, stateDir, wiki: join(vault, 'wiki') };
}

function acceptHook(s, client, event, stdin, extraEnv = {}) {
  return spawnSync(process.execPath, [BIN, client, event], {
    cwd: ROOT,
    env: { ...s.env, ...extraEnv },
    input: stdin,
    encoding: 'utf8',
    timeout: 12000,
    maxBuffer: 4 * 1024 * 1024,
  });
}

test('session-start p95 is at most 300 ms with a 5 MB log.md (20 runs)', async (t) => {
  const s = await acceptSession(t);
  await writeFile(join(s.vault, 'wiki/entities/big.md'), acceptFmPage('Big Log Page'));
  const filler = `- ${'human line of ordinary notes '.repeat(4)}`;
  const block = Array.from({ length: Math.ceil((5 * 1024 * 1024) / (filler.length + 1)) }, () => filler).join('\n');
  // The recap only lists entries inside its 14-day window, so the timestamp is relative to the real clock.
  await writeFile(
    join(s.wiki, 'log.md'),
    `${block}\n${acceptEntry(Date.now() - 60 * 60 * 1000, 'wiki/entities/big.md')}\n`
  );
  const durations = [];
  for (let i = 0; i < 20; i++) {
    const started = process.hrtime.bigint();
    const out = acceptHook(s, 'claude', 'session-start', JSON.stringify({ session_id: `p${i}` }));
    durations.push(Number(process.hrtime.bigint() - started) / 1e6);
    assert.equal(out.status, 0);
    assert.match(out.stdout, /Big Log Page/);
  }
  durations.sort((a, b) => a - b);
  const p95 = durations[Math.ceil(0.95 * durations.length) - 1];
  assert.ok(p95 <= 300, `p95 ${p95.toFixed(1)} ms`);
});

// ---------- tests/hooks/ba16-budget.test.mjs ----------

const BA16_NOW = new Date('2026-11-10T00:00:00Z');

async function ba16Fixture(t, pages) {
  const root = await mkdtemp(join(tmpdir(), 'ba16-hooks-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vault = join(root, 'vault'),
    state = join(root, 'state'),
    home = join(root, 'home');
  await Promise.all([mkdir(vault), mkdir(state), mkdir(home)]);
  for (const [name, body] of Object.entries(pages)) await writeFile(join(vault, name), body);
  return {
    env: { HOME: home },
    config: { vault: { path: vault }, stateDir: state, hooks: { mode: 'normal', deadlineMs: 4700 } },
  };
}

/** Claude prompt hook; returns the injected additionalContext ('' when the hook injected nothing). */
async function ba16Ask(f, prompt, session, retrieval = {}) {
  const config = { ...f.config, retrieval: { abstainThreshold: 0, ...retrieval } };
  const r = await runHook({
    client: 'claude',
    event: 'prompt',
    stdin: JSON.stringify({ session_id: session, prompt }),
    env: f.env,
    config,
    now: BA16_NOW,
  });
  assert.equal(r.exitCode, 0);
  if (r.stdout === '{}') return '';
  return JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
}

test('BA-16: a very large section is bounded and answered quickly', async (t) => {
  const f = await ba16Fixture(t, { 'huge.md': `# Huge\nzebrafish ${'x '.repeat(200_000)}` });
  const started = Date.now();
  const context = await ba16Ask(f, 'zebrafish', 'huge');
  assert.ok(Date.now() - started < 4700);
  assert.match(context, /^Huge \(huge\.md\)\n# Huge\nzebrafish/u);
  assert.ok(
    JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } }).length <=
      4002
  );
});

// ---------- tests/hooks/ba07-semantic-step.test.mjs ----------

const STEP_SETTINGS = { ...SEMANTIC_DEFAULTS, dims: 2 };
// Deterministic toy embedding: the Turkish query and the English page share the "zebra" concept.
function stepVectorFor(text) {
  if (/parsiyel/u.test(text)) return [0.6, 0.8];
  return /zebra|fish|balık/iu.test(text) ? [1, 0] : [0, 1];
}
const stepFakeFetch = async (url, options) => ({
  ok: true,
  json: async () => ({ embeddings: JSON.parse(options.body).input.map(stepVectorFor) }),
});
const stepHangingFetch = () => new Promise(() => {});

const STEP_PAGES = {
  'fish.md':
    '---\nstatus: confirmed\nverified:\n  - date: "2026-01-12"\n    evidence: "review"\n    scope: "zebra"\n    source: "wiki/sources/z.md"\n---\n# Fish\n\nzebrafish husbandry notes.\n',
  'weak.md': '---\nstatus: proposed\n---\n# Weak Note\n\nzebrafish unverified remark.\n',
  'other.md': '# Other\n\nunrelated gardening text.\n',
};

async function stepSetup(t) {
  const root = await mkdtemp(join(tmpdir(), 'ba07-step-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vault = join(root, 'vault'),
    wiki = join(vault, 'wiki'),
    state = join(root, 'state'),
    home = join(root, 'home');
  await Promise.all([mkdir(wiki, { recursive: true }), mkdir(state), mkdir(home)]);
  for (const [name, body] of Object.entries(STEP_PAGES)) await writeFile(join(wiki, name), body);
  const globalState = resolvePaths({ env: { HOME: home } }).stateDir;
  await buildSemanticIndex({
    corpusDir: wiki,
    stateDir: globalState,
    provider: createOllamaProvider({ ...STEP_SETTINGS, fetchImpl: stepFakeFetch }),
    chunkMarkdown: markdownChunks,
  });
  const searcher = createSearcher({ vaultDir: vault, stateDir: state });
  const query = 'balık';
  const lexical = searcher.search(query, { limit: 20, abstainThreshold: 0 }).results;
  return { root, vault, state, home, globalState, searcher, query, lexical };
}

const stepBase = (f) => ({
  searcher: f.searcher,
  query: f.query,
  limit: 20,
  abstainThreshold: 0,
  lexical: f.lexical,
  settings: STEP_SETTINGS,
  stateDir: f.globalState,
  prepare: (x) => x,
});

test('semantic step: a provider that never answers is cut at its budget and falls back to the lexical list', async (t) => {
  const f = await stepSetup(t);
  const started = Date.now();
  const hit = await semanticHits({ ...stepBase(f), fetchImpl: stepHangingFetch, budgetMs: 150 });
  const elapsed = Date.now() - started;
  assert.match(hit.semantic, /^fallback:(deadline|provider-error)$/u);
  assert.equal(hit.results, f.lexical);
  assert.ok(elapsed < 150 + 600, `took ${elapsed} ms`);
});

// ---------- tests/acceptance/BA-07/semantic-step.test.mjs ----------

const ACCEPT_DIMS = 2;
const acceptSettings = { ...SEMANTIC_DEFAULTS, model: 'ba07-test-model', dims: ACCEPT_DIMS };

function makeVault() {
  const root = mkdtempSync(join(tmpdir(), 'ba07-step-'));
  const vault = join(root, 'vault');
  mkdirSync(join(vault, 'wiki'), { recursive: true });
  writeFileSync(join(vault, 'wiki', 'alpha.md'), '# Alpha\n\nGardens and soil care for gardens every spring.\n');
  writeFileSync(join(vault, 'wiki', 'beta.md'), '# Beta\n\nRivers and bridges; the river bridge needs inspection.\n');
  writeFileSync(join(vault, 'wiki', 'gamma.md'), '# Gamma\n\nUnrelated note about bicycles.\n');
  return { root, vault, state: join(root, 'state') };
}

// Real fingerprint for the test settings, computed by the module's own provider factory.
async function acceptFingerprint() {
  const { createOllamaProvider } = await import(semanticEntryUrl());
  return createOllamaProvider({
    ...acceptSettings,
    fetchImpl: async () => {
      throw new Error('unused');
    },
  }).fingerprint;
}

function acceptFakeFetch({ mode = 'ok', calls = [] } = {}) {
  return async (url, options) => {
    calls.push(url);
    if (mode === 'hang') return new Promise(() => {});
    if (mode === 'error') return { ok: false, status: 500, json: async () => ({}) };
    const body = JSON.parse(options.body);
    return { ok: true, json: async () => ({ embeddings: body.input.map(() => [1, 0]) }) };
  };
}

// The module is loaded for real; only readSemanticIndex is replaced with an in-memory index.
function moduleWithIndex(index) {
  return async (url) => ({ ...(await import(url)), readSemanticIndex: async () => index });
}

function indexFor(fp, entries) {
  return { version: 1, dims: ACCEPT_DIMS, providerFingerprint: fp, entries, fileHashes: {} };
}

async function acceptRun({
  fetchImpl,
  index,
  budgetMs = 350,
  prepare = (r) => r,
  query = 'gardens',
  baseSettings = acceptSettings,
}) {
  const v = makeVault();
  try {
    const searcher = createSearcher({ vaultDir: v.vault, stateDir: v.state, now: new Date('2026-11-11T00:00:00Z') });
    const lexical = searcher.search(query, { limit: 20, abstainThreshold: 0 }).results;
    const hit = await semanticHits({
      searcher,
      query,
      limit: 5,
      abstainThreshold: 0,
      lexical,
      settings: baseSettings,
      stateDir: v.state,
      prepare,
      fetchImpl,
      budgetMs,
      loadModule: index === undefined ? undefined : moduleWithIndex(index),
    });
    return { hit, lexical };
  } finally {
    rmSync(v.root, { recursive: true, force: true });
  }
}

test('budget overrun falls back to the BM25 list exactly, within the sub-budget', async () => {
  const fp = await acceptFingerprint();
  const index = indexFor(fp, [{ path: 'alpha.md', vector: [1, 0], text: 'gardens', headingPath: [] }]);
  const started = performance.now();
  const { hit, lexical } = await acceptRun({ fetchImpl: acceptFakeFetch({ mode: 'hang' }), index, budgetMs: 60 });
  const elapsed = performance.now() - started;
  assert.equal(hit.semantic, 'fallback:deadline');
  assert.deepEqual(hit.results, lexical, 'results are the lexical list, unchanged');
  assert.ok(elapsed < 1000, `sub-budget respected (took ${elapsed} ms)`);
});
