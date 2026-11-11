// SPDX-License-Identifier: MIT
// BA-07: the semantic step itself (in-process, fake fetch) and its module-load trace. Hermetic: temporary directories,
// a fake fetch that answers locally, and child processes that never reach a provider. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { semanticHits } from '../../packages/hooks/src/semantic.mjs';
import { createSearcher } from '../../packages/core/src/retrieval/index.mjs';
import { resolvePaths } from '../../packages/core/src/paths/index.mjs';
import { SEMANTIC_DEFAULTS, defaultConfig } from '../../packages/core/src/config/index.mjs';
import { buildSemanticIndex, createOllamaProvider, markdownChunks } from '../../modules/semantic/src/index.mjs';

const ROOT = resolve('.');
const BIN = join(ROOT, 'packages/hooks/bin/brainatlas-hook.mjs');
const settings = {...SEMANTIC_DEFAULTS, dims: 2};
// Deterministic toy embedding: the Turkish query and the English page share the "zebra" concept.
function vectorFor(text) {
  if (/parsiyel/u.test(text)) return [0.6, 0.8];
  return /zebra|fish|balık/iu.test(text) ? [1, 0] : [0, 1];
}
const fakeFetch = async (url, options) => ({ok: true, json: async () => ({embeddings: JSON.parse(options.body).input.map(vectorFor)})});
const hangingFetch = () => new Promise(() => {});
const failingFetch = async () => { throw new Error('connection refused (simulated)'); };

const PAGES = {
  'fish.md': '---\nstatus: confirmed\nverified:\n  - date: "2026-01-12"\n    evidence: "review"\n    scope: "zebra"\n    source: "wiki/sources/z.md"\n---\n# Fish\n\nzebrafish husbandry notes.\n',
  'weak.md': '---\nstatus: proposed\n---\n# Weak Note\n\nzebrafish unverified remark.\n',
  'other.md': '# Other\n\nunrelated gardening text.\n',
};

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'ba07-step-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const vault = join(root, 'vault'), wiki = join(vault, 'wiki'), state = join(root, 'state'), home = join(root, 'home');
  await Promise.all([mkdir(wiki, {recursive: true}), mkdir(state), mkdir(home)]);
  for (const [name, body] of Object.entries(PAGES)) await writeFile(join(wiki, name), body);
  const globalState = resolvePaths({env: {HOME: home}}).stateDir;
  await buildSemanticIndex({corpusDir: wiki, stateDir: globalState, provider: createOllamaProvider({...settings, fetchImpl: fakeFetch}), chunkMarkdown: markdownChunks});
  const searcher = createSearcher({vaultDir: vault, stateDir: state});
  const query = 'balık';
  const lexical = searcher.search(query, {limit: 20, abstainThreshold: 0}).results;
  return {root, vault, state, home, globalState, searcher, query, lexical};
}

const base = f => ({searcher: f.searcher, query: f.query, limit: 20, abstainThreshold: 0, lexical: f.lexical, settings, stateDir: f.globalState, prepare: x => x});

test('semantic step: a Turkish query finds the English page that BM25 misses; trust is carried over', async t => {
  const f = await setup(t);
  assert.deepEqual(f.lexical, [], 'the lexical list is empty for this query (precondition)');
  const hit = await semanticHits({...base(f), fetchImpl: fakeFetch});
  assert.equal(hit.semantic, 'used');
  const paths = hit.results.map(r => r.path);
  assert.ok(paths.includes('wiki/fish.md'), JSON.stringify(paths));
  assert.equal(hit.results.find(r => r.path === 'wiki/weak.md')?.trust, 'weak');
  assert.equal(hit.results.find(r => r.path === 'wiki/fish.md')?.trust, 'verified');
  assert.ok(!paths.includes('wiki/other.md'));
});

test('semantic step: abstention keeps the lexical list exactly', async t => {
  const f = await setup(t);
  const query = 'parsiyel';
  const lexical = f.searcher.search(query, {limit: 20, abstainThreshold: 0}).results;
  const hit = await semanticHits({...base(f), query, lexical, settings: {...settings, minScore: 0.999}, fetchImpl: fakeFetch});
  assert.equal(hit.semantic, 'used');
  assert.equal(hit.results, lexical);
});

test('semantic step: a provider error falls back to the lexical list exactly', async t => {
  const f = await setup(t);
  const hit = await semanticHits({...base(f), fetchImpl: failingFetch});
  assert.equal(hit.semantic, 'fallback:provider-error');
  assert.equal(hit.results, f.lexical);
});

test('semantic step: a provider that never answers is cut at its budget and falls back to the lexical list', async t => {
  const f = await setup(t);
  const started = Date.now();
  const hit = await semanticHits({...base(f), fetchImpl: hangingFetch, budgetMs: 150});
  const elapsed = Date.now() - started;
  assert.match(hit.semantic, /^fallback:(deadline|provider-error)$/u);
  assert.equal(hit.results, f.lexical);
  assert.ok(elapsed < 150 + 600, `took ${elapsed} ms`);
});

test('semantic step: a missing or foreign index never reaches the provider', async t => {
  const f = await setup(t);
  let calls = 0;
  const counting = async (...args) => { calls++; return fakeFetch(...args); };
  const missingState = join(f.root, 'no-index-here');
  const missing = await semanticHits({...base(f), stateDir: missingState, fetchImpl: counting});
  assert.equal(missing.semantic, 'fallback:index-missing');
  assert.equal(calls, 0);
  const foreign = await semanticHits({...base(f), settings: {...settings, model: 'another-model'}, fetchImpl: counting});
  assert.equal(foreign.semantic, 'fallback:fingerprint-mismatch');
  assert.equal(calls, 0);
});

test('semantic step: the loader trace sees the module only when the semantic step is requested (Lite and Full-off never load it)', async t => {
  const f = await setup(t);
  const hooks = join(f.root, 'trace-hooks.mjs'), register = join(f.root, 'trace-register.mjs');
  await writeFile(hooks, "import { appendFileSync } from 'node:fs';\nexport async function resolve(specifier, context, next) {\n  appendFileSync(process.env.BA07_TRACE, specifier + '\\n');\n  return next(specifier, context);\n}\n");
  await writeFile(register, `import { register } from 'node:module';\nregister(${JSON.stringify(pathToFileURL(hooks).href)});\n`);
  // A fresh vault state and an index-less global state keep the Full-on run on the no-network path.
  const env = {PATH: process.env.PATH, HOME: join(f.root, 'trace-home')};
  const paths = resolvePaths({env});
  await mkdir(join(paths.configFile, '..'), {recursive: true});
  const vault = join(f.root, 'vault');
  const run = (profile, enabled) => {
    const cfg = defaultConfig(profile);
    cfg.vault.path = vault; cfg.retrieval.abstainThreshold = 0; cfg.semantic.enabled = enabled;
    if (profile === 'full') cfg.modules = ['*'];
    return cfg;
  };
  const trace = async cfg => {
    await writeFile(paths.configFile, JSON.stringify(cfg));
    const traceFile = join(f.root, `trace-${cfg.profile}-${cfg.semantic.enabled}.txt`);
    const r = spawnSync(process.execPath, ['--import', pathToFileURL(register).href, BIN, 'claude', 'prompt'],
      {input: JSON.stringify({session_id: `trace-${cfg.profile}-${cfg.semantic.enabled}`, prompt: 'zebra'}), env: {...env, BA07_TRACE: traceFile}, encoding: 'utf8', timeout: 15000});
    assert.equal(r.status, 0, r.stderr);
    const loads = existsSync(traceFile) ? (await readFile(traceFile, 'utf8')).split('\n').filter(Boolean) : [];
    return loads.filter(line => /modules\/semantic\//u.test(line)).length;
  };
  assert.equal(await trace(run('lite', true)), 0, 'Lite never loads the semantic module');
  assert.equal(await trace(run('full', false)), 0, 'Full with semantic off never loads it');
  assert.ok(await trace(run('full', true)) > 0, 'Full with semantic on loads it (the trace does observe worker loads)');
});
