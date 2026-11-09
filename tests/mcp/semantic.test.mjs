// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, symlink, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../packages/mcp/src/index.mjs';
import { defaultConfig, SEMANTIC_DEFAULTS } from '../../packages/core/src/config/index.mjs';
import { createSearcher } from '../../packages/core/src/index.mjs';
import { createOllamaProvider, updateSemanticIndex, markdownChunks } from '../../modules/semantic/src/index.mjs';

async function backgroundFixture(t, fetchImpl, semantic = {}) {
  const root = await mkdtemp(join(tmpdir(), 'mcp-background-'));
  const cleanups = [() => rm(root, { recursive: true, force: true })];
  t.after(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); });
  const wiki = join(root, 'vault/wiki'), stateDir = join(root, 'state'), releasesDir = join(root, 'releases'), release = join(releasesDir, 'v1'), currentDir = join(root, 'current');
  await mkdir(wiki, { recursive: true }); await mkdir(join(release, 'modules'), { recursive: true });
  await cp(resolve('modules/semantic'), join(release, 'modules/semantic'), { recursive: true }); await symlink(resolve('packages'), join(release, 'packages')); await symlink(release, currentDir);
  await writeFile(join(wiki, 'car.md'), '# Engine\ncar motor');
  const config = defaultConfig('custom'); config.modules = ['semantic']; config.vault.path = join(root, 'vault'); config.semantic = { ...SEMANTIC_DEFAULTS, enabled: true, dims: 2, ...semantic };
  const server = createServer({ config, paths: { stateDir, releasesDir, currentDir }, env: { HOME: root }, fetchImpl });
  const [ct, st] = InMemoryTransport.createLinkedPair(), client = new Client({ name: 'test', version: '1' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  cleanups.push(async () => { await client.close(); await server.close(); });
  const query = async () => JSON.parse((await client.callTool({ name: 'wiki_query', arguments: { query: 'car' } })).content[0].text);
  return { stateDir, server, client, query, cleanups };
}

test('closing MCP aborts an in-flight background index and removes its lock', async t => {
  let started, release;
  const inFlight = new Promise(resolve => { started = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const fetchImpl = async (_url, options) => { started(); await gate; return { ok: true, json: async () => ({ embeddings: JSON.parse(options.body).input.map(() => [1, 0]) }) }; };
  const { stateDir, server, query, cleanups } = await backgroundFixture(t, fetchImpl);
  cleanups.push(() => release());
  await query(); await inFlight;
  assert.deepEqual(await readdir(join(stateDir, 'semantic')), ['index.lock']);
  const closing = server.close(); release(); await closing;
  assert.deepEqual(await readdir(join(stateDir, 'semantic')), []);
});

test('closing MCP stops waiting after two seconds for a stuck provider', async t => {
  let started, release;
  const inFlight = new Promise(resolve => { started = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const fetchImpl = async (_url, options) => { started(); await gate; return { ok: true, json: async () => ({ embeddings: JSON.parse(options.body).input.map(() => [1, 0]) }) }; };
  const { server, query, cleanups } = await backgroundFixture(t, fetchImpl);
  cleanups.push(() => release());
  await query(); await inFlight;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const closing = server.close();
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(2000);
  await closing;
  t.mock.timers.reset();
  release();
});

test('background indexing uses its own timeout while query timeout falls back', async t => {
  const fetchImpl = async (_url, options) => { await new Promise(resolve => setTimeout(resolve, 50)); return { ok: true, json: async () => ({ embeddings: JSON.parse(options.body).input.map(() => [1, 0]) }) }; };
  const { stateDir, query } = await backgroundFixture(t, fetchImpl, { timeoutMs: 10, indexTimeoutMs: 1000, indexBatchSize: 1 });
  assert.equal((await query()).semantic.fallbackReason, 'index-missing');
  let index;
  for (let i = 0; i < 200 && !index; i++) {
    try { index = JSON.parse(await readFile(join(stateDir, 'semantic/index.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; await new Promise(resolve => setTimeout(resolve, 5)); }
  }
  assert.ok(index?.entries.length);
  const result = await query();
  assert.equal(result.semantic.fallbackReason, 'provider-error'); assert.equal(result.mode, 'lexical'); assert.equal(result.results[0].path, 'car.md');
});

test('MCP opt-in semantic search keeps lexical fallback and thresholds', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-semantic-'));
  const cleanups = [() => rm(root, { recursive: true, force: true })];
  t.after(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); });
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
  await Promise.all([server.connect(st), client.connect(ct)]); cleanups.push(async () => { await client.close(); await server.close(); });
  const query = async text => JSON.parse((await client.callTool({ name: 'wiki_query', arguments: { query: text } })).content[0].text);
  const cross = await query('araba'); assert.equal(cross.results[0].path, 'car.md'); assert.equal(cross.semantic.used, true); assert.equal(cross.results[0].heading, 'Engine');
  const absent = await query('irrelevant'); assert.equal(absent.abstained, true);
  const lexical = await query('motor'); assert.equal(lexical.abstained, false); assert.equal(lexical.results[0].path, 'car.md'); assert.ok(calls >= 4);
});

test('missing semantic module and manifest differ from an import failure', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-semantic-module-')); t.after(() => rm(root, { recursive: true, force: true }));
  const wiki = join(root, 'vault/wiki'), stateDir = join(root, 'state'), releasesDir = join(root, 'releases'), release = join(releasesDir, 'v1');
  const moduleDir = join(release, 'modules/semantic'), currentDir = join(root, 'current');
  await mkdir(wiki, { recursive: true }); await mkdir(join(release, 'modules'), { recursive: true });
  await writeFile(join(wiki, 'car.md'), '# Engine\ncar motor'); await symlink(release, currentDir);
  const config = defaultConfig('custom'); config.modules = ['semantic']; config.vault.path = join(root, 'vault'); config.semantic = { ...SEMANTIC_DEFAULTS, enabled: true, dims: 2 };
  const golden = createSearcher({ vaultDir: wiki, stateDir }).search('car', { limit: 5, budgetChars: 4000, abstainThreshold: 0.35 });
  let calls = 0;
  const query = async () => {
    const server = createServer({ config, paths: { stateDir, releasesDir, currentDir }, env: { HOME: root }, fetchImpl: async () => { calls++; throw new Error(); } });
    const [ct, st] = InMemoryTransport.createLinkedPair(), client = new Client({ name: 'test', version: '1' });
    await Promise.all([server.connect(st), client.connect(ct)]);
    try { return JSON.parse((await client.callTool({ name: 'wiki_query', arguments: { query: 'car' } })).content[0].text); }
    finally { await client.close(); await server.close(); }
  };
  for (const scenario of ['absent', 'manifest-missing', 'import-error']) {
    if (scenario === 'manifest-missing') await mkdir(moduleDir);
    if (scenario === 'import-error') {
      await cp(resolve('modules/semantic/module.json'), join(moduleDir, 'module.json'));
      await mkdir(join(moduleDir, 'src')); await writeFile(join(moduleDir, 'src/index.mjs'), 'throw new Error("import failed");\n');
    }
    const result = await query();
    assert.deepEqual({ results: result.results, abstained: result.abstained }, { results: golden.results, abstained: golden.abstained });
    assert.deepEqual(result.semantic, { used: false, fallbackReason: scenario === 'import-error' ? 'module-load-error' : 'module-missing' });
    assert.equal(result.mode, 'lexical');
  }
  assert.equal(calls, 0);
});

test('empty index rebuilds once when pages exist and remains valid for an empty vault', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-semantic-empty-'));
  const cleanups = [() => rm(root, { recursive: true, force: true })];
  t.after(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); });
  const wiki = join(root, 'vault/wiki'), stateDir = join(root, 'state'), releasesDir = join(root, 'releases'), release = join(releasesDir, 'v1'), currentDir = join(root, 'current');
  await mkdir(wiki, { recursive: true }); await mkdir(join(release, 'modules'), { recursive: true });
  await cp(resolve('modules/semantic'), join(release, 'modules/semantic'), { recursive: true }); await symlink(resolve('packages'), join(release, 'packages')); await symlink(release, currentDir);
  const config = defaultConfig('custom'); config.modules = ['semantic']; config.vault.path = join(root, 'vault'); config.semantic = { ...SEMANTIC_DEFAULTS, enabled: true, dims: 2 };
  let calls = 0, releaseBuild;
  const gate = new Promise(resolve => { releaseBuild = resolve; });
  const fetchImpl = async (_url, options) => { calls++; await gate; return { ok: true, json: async () => ({ embeddings: JSON.parse(options.body).input.map(() => [1, 0]) }) }; };
  const provider = createOllamaProvider({ ...config.semantic, fetchImpl });
  await updateSemanticIndex({ corpusDir: wiki, stateDir, provider, chunkMarkdown: markdownChunks });
  const server = createServer({ config, paths: { stateDir, releasesDir, currentDir }, env: { HOME: root }, fetchImpl });
  const [ct, st] = InMemoryTransport.createLinkedPair(), client = new Client({ name: 'test', version: '1' });
  await Promise.all([server.connect(st), client.connect(ct)]); cleanups.push(async () => { releaseBuild(); await client.close(); await server.close(); });
  const query = async () => JSON.parse((await client.callTool({ name: 'wiki_query', arguments: { query: 'car' } })).content[0].text);
  // Empty indexes remain usable when the vault contains no pages.
  releaseBuild();
  const empty = await query(); assert.equal(empty.semantic.used, true); assert.equal(calls, 1);
  await client.close(); await server.close();
  // Use a fresh server and a blocking provider to verify concurrent misses share one build.
  await writeFile(join(wiki, 'car.md'), '# Engine\ncar motor');
  let unblock, signal; const blocked = new Promise(resolve => { unblock = resolve; }); const building = new Promise(resolve => { signal = resolve; });
  let builds = 0;
  const blockedFetch = async (_url, options) => { builds++; signal(); await blocked; return { ok: true, json: async () => ({ embeddings: JSON.parse(options.body).input.map(() => [1, 0]) }) }; };
  const server2 = createServer({ config, paths: { stateDir, releasesDir, currentDir }, env: { HOME: root }, fetchImpl: blockedFetch });
  const [ct2, st2] = InMemoryTransport.createLinkedPair(), client2 = new Client({ name: 'test', version: '1' });
  await Promise.all([server2.connect(st2), client2.connect(ct2)]); cleanups.push(async () => { unblock(); await client2.close(); await server2.close(); });
  const golden = createSearcher({ vaultDir: wiki, stateDir }).search('car', { limit: 5, budgetChars: 4000, abstainThreshold: 0.35 });
  const query2 = async () => JSON.parse((await client2.callTool({ name: 'wiki_query', arguments: { query: 'car' } })).content[0].text);
  const first = await query2(); await building; const second = await query2();
  for (const result of [first, second]) {
    assert.deepEqual({ results: result.results, abstained: result.abstained }, { results: golden.results, abstained: golden.abstained });
    assert.deepEqual(result.semantic, { used: false, fallbackReason: 'index-missing' }); assert.equal(result.mode, 'lexical');
  }
  assert.equal(builds, 1); unblock();
  for (let i = 0; i < 100; i++) {
    const index = JSON.parse(await readFile(join(stateDir, 'semantic/index.json'), 'utf8'));
    if (index.entries.length) break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.ok(JSON.parse(await readFile(join(stateDir, 'semantic/index.json'), 'utf8')).entries.length);
  assert.equal(builds, 1);
});

test('MCP fallback, opt-out and remote policy preserve lexical answers without leaking inputs', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-semantic-fallback-'));
  const cleanups = [() => rm(root, { recursive: true, force: true })];
  t.after(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); });
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
    cleanups.push(async () => { await client.close(); await server.close(); });
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
