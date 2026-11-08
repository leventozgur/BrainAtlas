// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, symlink, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../packages/mcp/src/index.mjs';
import { defaultConfig, SEMANTIC_DEFAULTS } from '../../packages/core/src/config/index.mjs';
import { createSearcher } from '../../packages/core/src/index.mjs';
import { createOllamaProvider, updateSemanticIndex, markdownChunks } from '../../modules/semantic/src/index.mjs';

test('MCP opt-in semantic search keeps lexical fallback and thresholds', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-semantic-')); t.after(() => rm(root, { recursive: true, force: true }));
  const wiki = join(root, 'vault/wiki'), stateDir = join(root, 'state'), releasesDir = join(root, 'releases'), release = join(releasesDir, 'v1');
  await mkdir(wiki, { recursive: true }); await mkdir(join(release, 'modules'), { recursive: true });
  await cp(resolve('modules/semantic'), join(release, 'modules/semantic'), { recursive: true }); await symlink(resolve('packages'), join(release, 'packages'));
  await writeFile(join(wiki, 'car.md'), '# Engine\ncar motor');
  const currentDir = join(root, 'current'); await symlink(release, currentDir);
  let calls = 0;
  const fetchImpl = async (_url, options) => { calls++; return { ok: true, json: async () => ({ embeddings: JSON.parse(options.body).input.map(text => /irrelevant|motor/u.test(text) && text.startsWith('task:') ? [0, 1] : [1, 0]) }) }; };
  const config = defaultConfig('custom'); config.modules = ['semantic']; config.vault.path = join(root, 'vault'); config.semantic = { ...SEMANTIC_DEFAULTS, enabled: true, dims: 2 };
  const provider = createOllamaProvider({ ...config.semantic, fetchImpl });
  await updateSemanticIndex({ corpusDir: wiki, stateDir, provider, chunkMarkdown: markdownChunks });
  const server = createServer({ config, paths: { stateDir, releasesDir, currentDir }, env: { HOME: root }, fetchImpl });
  const [ct, st] = InMemoryTransport.createLinkedPair(); const client = new Client({ name: 'test', version: '1' });
  await Promise.all([server.connect(st), client.connect(ct)]); t.after(async () => { await client.close(); await server.close(); });
  const query = async text => JSON.parse((await client.callTool({ name: 'wiki_query', arguments: { query: text } })).content[0].text);
  const cross = await query('araba'); assert.equal(cross.results[0].path, 'car.md'); assert.equal(cross.semantic.used, true); assert.equal(cross.results[0].heading, 'Engine');
  const absent = await query('irrelevant'); assert.equal(absent.abstained, true);
  const lexical = await query('motor'); assert.equal(lexical.abstained, false); assert.equal(lexical.results[0].path, 'car.md'); assert.ok(calls >= 4);
});

test('MCP fallback, opt-out and remote policy preserve lexical answers without leaking inputs', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-semantic-fallback-')); t.after(() => rm(root, { recursive: true, force: true }));
  const wiki = join(root, 'vault/wiki'), stateDir = join(root, 'state'), releasesDir = join(root, 'releases'), release = join(releasesDir, 'v1');
  await mkdir(wiki, { recursive: true }); await mkdir(join(release, 'modules'), { recursive: true });
  await cp(resolve('modules/semantic'), join(release, 'modules/semantic'), { recursive: true }); await symlink(resolve('packages'), join(release, 'packages'));
  const currentDir = join(root, 'current'); await symlink(release, currentDir);
  await writeFile(join(wiki, 'car.md'), '# Engine\ncar motor privatepagecontent');
  const config = defaultConfig('custom'); config.modules = ['semantic']; config.vault.path = join(root, 'vault'); config.semantic = { ...SEMANTIC_DEFAULTS, enabled: true, dims: 2, timeoutMs: 10 };
  let calls = 0, behavior = 'ok';
  const fetchImpl = async (_url, opts) => {
    calls++;
    if (behavior === 'unreachable') throw new Error('privatequery privatepagecontent');
    if (behavior === 'timeout') return new Promise(() => {});
    if (behavior === 'malformed') return { ok: true, json: async () => ({ embeddings: 'bad' }) };
    if (behavior === 'dimension') return { ok: true, json: async () => ({ embeddings: [[1]] }) };
    return { ok: true, json: async () => ({ embeddings: JSON.parse(opts.body).input.map(() => [1, 0]) }) };
  };
  const connect = async (cfg, queryStateDir = stateDir) => {
    const server = createServer({ config: cfg, paths: { stateDir: queryStateDir, releasesDir, currentDir }, env: { HOME: root }, fetchImpl });
    const [ct, st] = InMemoryTransport.createLinkedPair(), client = new Client({ name: 'test', version: '1' });
    await Promise.all([server.connect(st), client.connect(ct)]);
    t.after(async () => { await client.close(); await server.close(); });
    return async query => JSON.parse((await client.callTool({ name: 'wiki_query', arguments: { query } })).content[0].text);
  };
  const disabled = structuredClone(config); disabled.semantic.enabled = false;
  const noModule = structuredClone(config); noModule.modules = [];
  const base = await connect(disabled), noMod = await connect(noModule);
  const legacy = createSearcher({ vaultDir: wiki, stateDir }).search('car', { limit: 5, budgetChars: 4000, abstainThreshold: 0.35 });
  const golden = await base('car'); assert.deepEqual(golden, { results: legacy.results, abstained: legacy.abstained }); assert.ok(golden.results.length); assert.deepEqual(await noMod('car'), golden); assert.equal(calls, 0);
  const remote = structuredClone(config); remote.semantic.baseUrl = 'http://remote.invalid';
  const remoteQuery = await connect(remote); const refused = await remoteQuery('car');
  assert.deepEqual(refused.results, golden.results); assert.equal(refused.semantic.fallbackReason, 'remote-not-allowed'); assert.equal(calls, 0);
  const missingQuery = await connect(config, join(root, 'missing-state'));
  const missing = await missingQuery('car'); assert.deepEqual(missing.results, golden.results); assert.equal(missing.semantic.fallbackReason, 'index-missing');
  const provider = createOllamaProvider({ ...config.semantic, fetchImpl });
  await updateSemanticIndex({ corpusDir: wiki, stateDir, provider, chunkMarkdown: markdownChunks });
  const enabled = await connect(config);
  for (const name of ['unreachable', 'timeout', 'malformed', 'dimension']) {
    behavior = name; const result = await enabled('car');
    assert.deepEqual(result.results, golden.results, name); assert.equal(result.semantic.fallbackReason, 'provider-error', name);
    assert.ok(!JSON.stringify(result.semantic).includes('privatepagecontent'));
  }
  behavior = 'ok';
  const mismatch = structuredClone(config); mismatch.semantic.model = 'different';
  const mismatchQuery = await connect(mismatch); const mismatchResult = await mismatchQuery('car');
  assert.deepEqual(mismatchResult.results, golden.results); assert.equal(mismatchResult.semantic.fallbackReason, 'fingerprint-mismatch');
  const allowed = structuredClone(config); allowed.semantic.baseUrl = 'http://remote.invalid'; allowed.semantic.allowRemote = true;
  const allowedQuery = await connect(allowed); const before = calls;
  const accepted = await allowedQuery('araba'); assert.equal(accepted.semantic.used, true); assert.equal(accepted.results[0].path, 'car.md'); assert.ok(calls > before);
});
