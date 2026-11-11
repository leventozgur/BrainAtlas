// SPDX-License-Identifier: MIT
// BA-07 acceptance (independent): the prompt hook's optional semantic step, exercised offline.
// Provider and fetch are fakes; no socket is opened. The real module is loaded, only its index reader is replaced.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createSearcher } from '../../../packages/core/src/retrieval/index.mjs';
import { SEMANTIC_DEFAULTS } from '../../../packages/core/src/config/index.mjs';
import { semanticHits, semanticEntryUrl, semanticRequested } from '../../../packages/hooks/src/semantic.mjs';

const DIMS = 2;
const settings = { ...SEMANTIC_DEFAULTS, model: 'ba07-test-model', dims: DIMS };

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
async function fingerprint() {
  const { createOllamaProvider } = await import(semanticEntryUrl());
  return createOllamaProvider({ ...settings, fetchImpl: async () => { throw new Error('unused'); } }).fingerprint;
}

function fakeFetch({ mode = 'ok', calls = [] } = {}) {
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
  return async url => ({ ...(await import(url)), readSemanticIndex: async () => index });
}

function indexFor(fp, entries) {
  return { version: 1, dims: DIMS, providerFingerprint: fp, entries, fileHashes: {} };
}

async function run({ fetchImpl, index, budgetMs = 350, prepare = r => r, query = 'gardens', baseSettings = settings }) {
  const v = makeVault();
  try {
    const searcher = createSearcher({ vaultDir: v.vault, stateDir: v.state, now: new Date('2026-11-11T00:00:00Z') });
    const lexical = searcher.search(query, { limit: 20, abstainThreshold: 0 }).results;
    const hit = await semanticHits({ searcher, query, limit: 5, abstainThreshold: 0, lexical, settings: baseSettings,
      stateDir: v.state, prepare, fetchImpl, budgetMs, loadModule: index === undefined ? undefined : moduleWithIndex(index) });
    return { hit, lexical };
  } finally { rmSync(v.root, { recursive: true, force: true }); }
}

test('budget overrun falls back to the BM25 list exactly, within the sub-budget', async () => {
  const fp = await fingerprint();
  const index = indexFor(fp, [{ path: 'alpha.md', vector: [1, 0], text: 'gardens', headingPath: [] }]);
  const started = performance.now();
  const { hit, lexical } = await run({ fetchImpl: fakeFetch({ mode: 'hang' }), index, budgetMs: 60 });
  const elapsed = performance.now() - started;
  assert.equal(hit.semantic, 'fallback:deadline');
  assert.deepEqual(hit.results, lexical, 'results are the lexical list, unchanged');
  assert.ok(elapsed < 1000, `sub-budget respected (took ${elapsed} ms)`);
});

test('a provider error falls back to the BM25 list exactly', async () => {
  const fp = await fingerprint();
  const index = indexFor(fp, [{ path: 'alpha.md', vector: [1, 0], text: 'gardens', headingPath: [] }]);
  const { hit, lexical } = await run({ fetchImpl: fakeFetch({ mode: 'error' }), index });
  assert.equal(hit.semantic, 'fallback:provider-error');
  assert.deepEqual(hit.results, lexical);
});

test('a missing index falls back to the BM25 list without calling the provider', async () => {
  const calls = [];
  const { hit, lexical } = await run({ fetchImpl: fakeFetch({ calls }), index: { version: 1, dims: DIMS, providerFingerprint: 'x', entries: [], fileHashes: {} } });
  assert.equal(hit.semantic, 'fallback:index-missing');
  assert.deepEqual(hit.results, lexical);
  assert.equal(calls.length, 0, 'no embedding request without an index');
});

test('a fingerprint mismatch falls back before any embedding request', async () => {
  const calls = [];
  const index = indexFor('0000000000000000', [{ path: 'alpha.md', vector: [1, 0], text: 'gardens', headingPath: [] }]);
  const { hit, lexical } = await run({ fetchImpl: fakeFetch({ calls }), index });
  assert.equal(hit.semantic, 'fallback:fingerprint-mismatch');
  assert.deepEqual(hit.results, lexical);
  assert.equal(calls.length, 0, 'no request is sent on a fingerprint mismatch');
});

test('a remote provider URL is refused and the provider is never called', async () => {
  const calls = [];
  const remote = { ...settings, baseUrl: 'https://models.example.test' };
  const index = indexFor(await fingerprint(), [{ path: 'alpha.md', vector: [1, 0], text: 'gardens', headingPath: [] }]);
  const { hit, lexical } = await run({ fetchImpl: fakeFetch({ calls }), index, baseSettings: remote });
  assert.equal(hit.semantic, 'fallback:remote-not-allowed');
  assert.deepEqual(hit.results, lexical);
  assert.equal(calls.length, 0, 'no request to a remote host');
});

test('a used semantic result is deduplicated by page and passes through the prepare step', async () => {
  const fp = await fingerprint();
  // Two chunks of beta.md: the better one must win, and beta.md must appear once.
  const index = indexFor(fp, [
    { path: 'beta.md', vector: [0.2, 0.8], text: 'weak chunk', headingPath: ['Beta'] },
    { path: 'beta.md', vector: [1, 0], text: 'river bridge chunk', headingPath: ['Beta'] },
    { path: 'alpha.md', vector: [0.6, 0.4], text: 'gardens chunk', headingPath: ['Alpha'] },
  ]);
  const prepared = [];
  const prepare = r => { prepared.push(r.path); return r; };
  const { hit } = await run({ fetchImpl: fakeFetch(), index, prepare, query: 'river' });
  assert.equal(hit.semantic, 'used');
  const paths = hit.results.map(r => r.path);
  assert.equal(new Set(paths).size, paths.length, 'no duplicate pages');
  // Index entries are relative to wiki/; the hook's page paths are relative to the vault root.
  const beta = hit.results.find(r => r.path === 'wiki/beta.md');
  assert.ok(beta, 'semantic page is mapped to its vault path');
  assert.equal(beta.semanticScore, 1, 'the best chunk of the page is the one scored');
  assert.deepEqual([...new Set(prepared)].sort(), [...new Set(paths)].sort(), 'every semantic result passes prepare');
});

test('secret-shaped content in a semantic chunk is redacted when the caller applies redaction', async () => {
  const { redact } = await import('../../../packages/core/src/safety/index.mjs');
  const fp = await fingerprint();
  const secret = 'AKIAIOSFODNN7EXAMPLE';
  // The query matches only gamma.md lexically, so beta.md can reach the output only through the semantic chunk text.
  const index = indexFor(fp, [{ path: 'beta.md', vector: [1, 0], text: `river key ${secret} bridge`, headingPath: [] }]);
  const { hit } = await run({ fetchImpl: fakeFetch(), index, query: 'bicycles', prepare: r => ({ ...r, snippet: redact(r.snippet) }) });
  assert.equal(hit.semantic, 'used');
  const beta = hit.results.find(r => r.path === 'wiki/beta.md');
  assert.ok(beta, 'the semantic-only page is in the results');
  assert.equal(typeof beta.snippet, 'string');
  assert.ok(!beta.snippet.includes(secret), 'secret value is not injected');
  assert.match(beta.snippet, /\[REDACTED/u, 'the secret was replaced by a marker');
});

test('semantic step is requested only for an opted-in, non-Lite profile that includes the module', () => {
  const on = { semantic: { enabled: true }, profile: 'full', modules: ['*'] };
  assert.equal(semanticRequested(on), true);
  assert.equal(semanticRequested({ ...on, profile: 'lite' }), false, 'Lite never requests it');
  assert.equal(semanticRequested({ ...on, semantic: { enabled: false } }), false, 'opt-out is honored');
  assert.equal(semanticRequested({ ...on, modules: [] }), false, 'module must be included');
  assert.equal(semanticRequested({}), false);
});
