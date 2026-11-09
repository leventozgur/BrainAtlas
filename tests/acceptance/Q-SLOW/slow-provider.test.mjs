// SPDX-License-Identifier: MIT
// Acceptance (1): a slow provider (8 s per request, simulated with mocked timers) with default config.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../../packages/mcp/src/index.mjs';
import { defaultConfig, SEMANTIC_DEFAULTS } from '../../../packages/core/src/config/index.mjs';
import { commands, createOllamaProvider, readSemanticIndex } from '../../../modules/semantic/src/index.mjs';
import { createSearcher } from '../../../packages/core/src/retrieval/index.mjs';
import { drive, exists, sectionPage, workspace } from './helpers.mjs';

const EPOCH = 1_700_000_000_000;
const enable = t => t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: EPOCH });

function slowFetch(ms, log = []) {
  return async (url, request) => {
    const body = JSON.parse(request.body);
    log.push({ at: Date.now(), size: body.input.length });
    await new Promise(resolve => setTimeout(resolve, ms));
    return { ok: true, json: async () => ({ embeddings: body.input.map(() => [1, 0]) }) };
  };
}
function commandContext(w, config, fetchImpl) {
  return { config, env: { HOME: w.root }, paths: { stateDir: w.stateDir }, fetchImpl };
}
function configFor(w, overrides = {}) {
  const config = defaultConfig('custom');
  config.modules = ['semantic']; config.vault.path = w.vault;
  config.semantic = { ...SEMANTIC_DEFAULTS, enabled: true, dims: 2, ...overrides };
  return config;
}

test('default config: semanticIndex completes against a provider that takes 8 s per request (index timeout applies, not the 5 s query timeout)', async t => {
  const w = await workspace(t, { 'page.md': sectionPage('Page', 70) });
  const config = configFor(w);
  assert.equal(config.semantic.timeoutMs, 5000);
  assert.equal(config.semantic.indexTimeoutMs, 120000);
  enable(t);
  const log = [];
  const result = await drive(t, commands.semanticIndex([], commandContext(w, config, slowFetch(8000, log))));
  assert.deepEqual(result, { indexed: 1 });
  assert.deepEqual(log.map(item => item.size), [32, 32, 6]);
  assert.ok(log[1].at - log[0].at >= 8000, 'requests are sequential and each took the simulated 8 s');
  const index = await readSemanticIndex(w.stateDir);
  assert.equal(index.entries.length, 70);
  assert.equal(await exists(join(w.semanticDir, 'index.partial.json')), false);
  assert.equal(await exists(join(w.semanticDir, 'index.lock')), false);
});

test('the index timeout is what governs indexing: indexTimeoutMs below the request time fails, above succeeds', async t => {
  const w = await workspace(t, { 'page.md': sectionPage('Page', 5) });
  enable(t);
  const tight = configFor(w, { indexTimeoutMs: 7999 });
  await assert.rejects(drive(t, commands.semanticIndex([], commandContext(w, tight, slowFetch(8000))), 1, 20000), error => { assert.equal(error.code, 'E_SEMANTIC_PROVIDER'); assert.match(error.message, /timed out/iu); return true; });
  assert.equal(await readSemanticIndex(w.stateDir), null);
  const edge = configFor(w, { indexTimeoutMs: 8001 });
  assert.deepEqual(await drive(t, commands.semanticIndex([], commandContext(w, edge, slowFetch(8000))), 1, 20000), { indexed: 1 });
});

test('the query path still applies timeoutMs (5000): a query against the 8 s provider times out', async t => {
  enable(t);
  const settings = { ...SEMANTIC_DEFAULTS, dims: 2, model: 'm' };
  const provider = createOllamaProvider({ ...settings, fetchImpl: slowFetch(8000) });
  await assert.rejects(drive(t, provider.embedQuery('anything')), error => { assert.equal(error.code, 'E_SEMANTIC_PROVIDER'); assert.match(error.message, /timed out/iu); return true; });
  const justFast = createOllamaProvider({ ...settings, fetchImpl: slowFetch(4999) });
  assert.deepEqual(Array.from(await drive(t, justFast.embedQuery('q'), 1, 20000)), [1, 0]);
  const justSlow = createOllamaProvider({ ...settings, fetchImpl: slowFetch(5001) });
  await assert.rejects(drive(t, justSlow.embedQuery('q'), 1, 20000), /timed out/iu);
});

test('fingerprint of the indexing provider equals the query provider fingerprint (timeouts and batch size do not matter)', async t => {
  const base = { ...SEMANTIC_DEFAULTS, dims: 2, model: 'm', fetchImpl: async () => { throw new Error('unused'); } };
  const reference = createOllamaProvider(base).fingerprint;
  for (const extra of [{ timeoutMs: 1 }, { timeoutMs: 999999 }, { batchSize: 1 }, { batchSize: 64 }, { timeoutMs: 120000, batchSize: 32 }]) {
    assert.equal(createOllamaProvider({ ...base, ...extra }).fingerprint, reference, JSON.stringify(extra));
  }
});

test('wiki_query against a slow provider still times out at timeoutMs 5000 and falls back to BM25', async t => {
  const w = await workspace(t, { 'one.md': '---\ntype: entity\ntitle: One\nstatus: active\n---\n# One\nvioletneedle evidence\n', 'index.md': '# Wiki Index\n', 'log.md': '# Log\n' });
  const config = configFor(w);
  // Build a valid index quickly first (before enabling the mocked clock), with the same provider identity the server will use.
  const quick = async (url, request) => ({ ok: true, json: async () => ({ embeddings: JSON.parse(request.body).input.map(() => [1, 0]) }) });
  await commands.semanticIndex([], commandContext(w, config, quick));
  const lexical = createSearcher({ vaultDir: w.wiki, stateDir: w.stateDir }).search('violetneedle', { limit: 5, budgetChars: 4000, abstainThreshold: 0.35 });
  const paths = { stateDir: w.stateDir, releasesDir: join(w.root, 'releases'), currentDir: join(w.root, 'current') };
  await mkdir(paths.releasesDir, { recursive: true });
  const { cp, symlink } = await import('node:fs/promises');
  const release = join(paths.releasesDir, 'v1');
  await mkdir(join(release, 'modules'), { recursive: true });
  const repo = new URL('../../../', import.meta.url).pathname;
  await cp(join(repo, 'modules/semantic'), join(release, 'modules/semantic'), { recursive: true });
  await symlink(join(repo, 'packages'), join(release, 'packages'));
  await symlink(release, paths.currentDir);
  enable(t);
  const calls = [];
  const server = createServer({ config, paths, env: { HOME: w.root }, fetchImpl: slowFetch(8000, calls) });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'q-slow', version: '1' });
  await drive(t, Promise.all([server.connect(serverTransport), client.connect(clientTransport)]));
  t.after(async () => { await client.close(); await server.close(); });
  const response = await drive(t, client.callTool({ name: 'wiki_query', arguments: { query: 'violetneedle' } }), 250);
  const payload = JSON.parse(response.content[0].text);
  assert.deepEqual(payload.results, lexical.results);
  assert.equal(payload.semantic.used, false);
  assert.equal(payload.semantic.fallbackReason, 'provider-error');
  assert.equal(payload.mode, 'lexical');
  assert.equal(calls.length, 1, 'one query embedding was attempted');
});
