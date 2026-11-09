// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, readFile, readdir, rm, symlink, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../../packages/mcp/src/index.mjs';
import { createSearcher } from '../../../packages/core/src/retrieval/index.mjs';
import { defaultConfig, SEMANTIC_DEFAULTS, validateConfig } from '../../../packages/core/src/config/index.mjs';
import { createOllamaProvider, markdownChunks, updateSemanticIndex } from '../../../modules/semantic/src/index.mjs';

const repo = resolve(new URL('../../../', import.meta.url).pathname);
const secret = () => ['sk', 'test' + 'x'.repeat(24)].join('-');
const markdown = (title, body) => '---\ntype: entity\ntitle: ' + title + '\nstatus: active\n---\n# ' + title + '\n' + body + '\n';

async function fixture(t, { installSemantic = true, files = {}, fetchImpl } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'q-semwire-mcp-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vault = join(root, 'vault');
  const wiki = join(vault, 'wiki');
  const stateDir = join(root, 'state');
  const releasesDir = join(root, 'releases');
  const release = join(releasesDir, 'v1');
  const currentDir = join(root, 'current');
  await mkdir(wiki, { recursive: true });
  await mkdir(join(release, 'modules'), { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(wiki, 'index.md'), '# Wiki Index\n');
  await writeFile(join(wiki, 'log.md'), '# Log\n');
  for (const [file, body] of Object.entries(files)) {
    await mkdir(join(wiki, file, '..'), { recursive: true });
    await writeFile(join(wiki, file), body);
  }
  if (installSemantic) {
    await cp(join(repo, 'modules/semantic'), join(release, 'modules/semantic'), { recursive: true });
    await symlink(join(repo, 'packages'), join(release, 'packages'));
  }
  await symlink(release, currentDir);
  const config = defaultConfig('custom');
  config.vault.path = vault;
  config.modules = installSemantic ? ['semantic'] : [];
  config.semantic = { ...SEMANTIC_DEFAULTS, enabled: true, dims: 2, timeoutMs: 30 };
  const paths = { stateDir, releasesDir, currentDir };
  const env = { HOME: root };
  const connect = async (cfg = config, state = stateDir, fetch = fetchImpl) => {
    const server = createServer({ config: cfg, paths: { ...paths, stateDir: state }, env, fetchImpl: fetch });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'q-semwire-acceptance', version: '1' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    t.after(async () => { await client.close(); await server.close(); });
    return client;
  };
  return { root, vault, wiki, stateDir, releasesDir, currentDir, config, connect };
}

const call = (client, name, args = {}) => client.callTool({ name, arguments: args });
const payload = (response) => {
  assert.notEqual(response.isError, true, JSON.stringify(response));
  return JSON.parse(response.content[0].text);
};
async function connectSemanticIndex(f, fetchImpl) {
  const provider = createOllamaProvider({ ...f.config.semantic, fetchImpl });
  return updateSemanticIndex({ corpusDir: f.wiki, stateDir: f.stateDir, provider, chunkMarkdown: markdownChunks });
}
async function tree(root, prefix = '') {
  const result = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const rel = join(prefix, entry.name);
    result.push(rel + (entry.isDirectory() ? '/' : ''));
    if (entry.isDirectory()) result.push(...await tree(root, rel));
  }
  return result.sort();
}

test('semantic absent, disabled, and uninstalled preserve the lexical golden shape and make no provider calls', async t => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error('unexpected provider call'); };
  const f = await fixture(t, { files: { 'one.md': markdown('One', 'violetneedle evidence') }, fetchImpl });
  const lexical = createSearcher({ vaultDir: f.wiki, stateDir: f.stateDir });
  const golden = lexical.search('violetneedle', { limit: 5, budgetChars: 4000, abstainThreshold: 0.35 });
  const expected = { results: golden.results, abstained: golden.abstained };

  const absent = structuredClone(f.config); delete absent.semantic;
  const disabled = structuredClone(f.config); disabled.semantic.enabled = false;
  const noModule = structuredClone(f.config); noModule.modules = [];
  for (const cfg of [absent, disabled, noModule]) {
    const client = await f.connect(cfg, f.stateDir, fetchImpl);
    const actual = payload(await call(client, 'wiki_query', { query: 'violetneedle' }));
    assert.deepEqual(actual, expected);
    assert.deepEqual(Object.keys(actual).sort(), ['abstained', 'results']);
  }
  assert.equal(calls, 0);
  await assert.rejects(stat(join(f.stateDir, 'semantic')) , { code: 'ENOENT' });

  const missing = await fixture(t, { installSemantic: false, files: { 'one.md': markdown('One', 'violetneedle evidence') }, fetchImpl });
  missing.config.modules = ['semantic'];
  const missingGolden = createSearcher({ vaultDir: missing.wiki, stateDir: missing.stateDir }).search('violetneedle', { limit: 5, budgetChars: 4000, abstainThreshold: 0.35 });
  const missingClient = await missing.connect(missing.config, missing.stateDir, fetchImpl);
  const missingResponse = payload(await call(missingClient, 'wiki_query', { query: 'violetneedle' }));
  // PM decision: with semantic.enabled=true but the module absent, the answer stays the BM25 golden result and states why semantic was skipped.
  assert.deepEqual({ results: missingResponse.results, abstained: missingResponse.abstained }, { results: missingGolden.results, abstained: missingGolden.abstained });
  assert.equal(missingResponse.semantic?.used, false);
  assert.equal(missingResponse.semantic?.fallbackReason, 'module-missing');
  assert.equal(calls, 0);
  await assert.rejects(stat(join(missing.stateDir, 'semantic')), { code: 'ENOENT' });
});

test('enabled semantic ranks a cross-language hit in the first five and maps section fields', async t => {
  const files = {};
  for (let i = 0; i < 7; i++) files['distractor-' + i + '.md'] = markdown('Distractor ' + i, 'ordinary material for retrieval');
  files['english-target.md'] = markdown('Travel Engine', 'A car carries passengers on the road.');
  const fetchImpl = async (_url, options) => {
    const inputs = JSON.parse(options.body).input;
    return { ok: true, json: async () => ({ embeddings: inputs.map(text => /car carries passengers/.test(text) || text.includes('task: search result | query: araba') ? [1, 0] : [0, 1]) }) };
  };
  const f = await fixture(t, { files, fetchImpl });
  await connectSemanticIndex(f, fetchImpl);
  const before = await tree(f.vault);
  const client = await f.connect(f.config, f.stateDir, fetchImpl);
  const response = payload(await call(client, 'wiki_query', { query: 'araba', limit: 5 }));
  assert.equal(response.semantic.used, true);
  assert.equal(response.mode, 'semantic-primary');
  assert.ok(response.results.slice(0, 5).some(item => item.path === 'english-target.md'));
  const target = response.results.find(item => item.path === 'english-target.md');
  assert.equal(target.heading, 'Travel Engine');
  assert.equal(target.anchor, 'travel-engine');
  assert.equal(target.headingPath, 'Travel Engine');
  for (const key of ['path', 'title', 'score', 'snippet', 'stale', 'status', 'heading', 'anchor', 'headingPath']) assert.ok(Object.hasOwn(target, key), key);
  assert.deepEqual(await tree(f.vault), before, 'semantic state belongs outside the vault');
  assert.ok((await readFile(join(f.stateDir, 'semantic/index.json'), 'utf8')).length > 0);
});

test('semantic abstention preserves lexical strong matches and abstains on two weak signals', async t => {
  const files = {
    'lexical.md': markdown('Lexical', 'quartzneedle exact technical term'),
    'other.md': markdown('Other', 'unrelated evidence'),
  };
  const fetchImpl = async (_url, options) => ({ ok: true, json: async () => ({ embeddings: JSON.parse(options.body).input.map(text => text.startsWith('task:') ? [1, 0] : [0, 1]) }) });
  const f = await fixture(t, { files, fetchImpl });
  await connectSemanticIndex(f, fetchImpl);
  const client = await f.connect(f.config, f.stateDir, fetchImpl);
  const strong = payload(await call(client, 'wiki_query', { query: 'quartzneedle' }));
  assert.equal(strong.abstained, false);
  assert.ok(strong.results.some(row => row.path === 'lexical.md'));
  const weak = payload(await call(client, 'wiki_query', { query: 'unseen-turkish-question' }));
  assert.equal(weak.abstained, true);
  assert.deepEqual(weak.results, []);
});

test('missing and malformed indexes fall back to BM25 and a first miss starts an index build', async t => {
  let calls = 0;
  const fetchImpl = async (_url, options) => {
    calls++;
    return { ok: true, json: async () => ({ embeddings: JSON.parse(options.body).input.map(() => [1, 0]) }) };
  };
  const f = await fixture(t, { files: { 'answer.md': markdown('Answer', 'needle lexical evidence') }, fetchImpl });
  const client = await f.connect(f.config, f.stateDir, fetchImpl);
  const first = payload(await call(client, 'wiki_query', { query: 'needle' }));
  assert.deepEqual(first.results.map(row => row.path), ['answer.md']);
  assert.equal(first.semantic.fallbackReason, 'index-missing');
  for (let i = 0; i < 50; i++) {
    try { await stat(join(f.stateDir, 'semantic/index.json')); break; } catch { await new Promise(resolve => setTimeout(resolve, 5)); }
  }
  assert.ok(calls > 0, 'the first index miss schedules a background build');
  await writeFile(join(f.stateDir, 'semantic/index.json'), '{broken');
  const second = payload(await call(client, 'wiki_query', { query: 'needle' }));
  assert.deepEqual(second.results.map(row => row.path), ['answer.md']);
  assert.equal(second.semantic.fallbackReason, 'index-missing');
  let recovered = false;
  for (let i = 0; i < 100; i++) {
    try {
      const data = JSON.parse(await readFile(join(f.stateDir, 'semantic/index.json'), 'utf8'));
      if (Array.isArray(data.entries) && data.entries.length > 0) { recovered = true; break; }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(recovered, true, 'the malformed index should be rebuilt in the background');
});

test('an empty persisted index is treated as missing rather than a successful semantic abstention', async t => {
  const fetchImpl = async (_url, options) => ({ ok: true, json: async () => ({ embeddings: JSON.parse(options.body).input.map(() => [1, 0]) }) });
  const f = await fixture(t, { files: { 'answer.md': markdown('Answer', 'needle lexical evidence') }, fetchImpl });
  const provider = await connectSemanticIndex(f, fetchImpl);
  await writeFile(join(f.stateDir, 'semantic/index.json'), JSON.stringify({
    version: 1, providerId: provider.providerId, providerFingerprint: provider.providerFingerprint,
    preprocessVersion: provider.preprocessVersion, dims: provider.dims, createdAt: new Date().toISOString(),
    fileHashes: {}, entries: [],
  }));
  const client = await f.connect(f.config, f.stateDir, fetchImpl);
  const result = payload(await call(client, 'wiki_query', { query: 'needle' }));
  assert.ok(result.results.some(row => row.path === 'answer.md'));
  assert.equal(result.semantic.fallbackReason, 'index-missing');
  assert.equal(result.mode, 'lexical');
});

test('provider failures, timeouts, bad JSON, HTTP errors, wrong dimensions and non-finite vectors fall back without leaking diagnostics', async t => {
  const marker = secret();
  const behaviors = {
    rejected: async () => { throw new Error(marker); },
    timeout: async () => new Promise(() => {}),
    http500: async () => ({ ok: false, status: 500 }),
    badJson: async () => ({ ok: true, json: async () => { throw new Error(marker); } }),
    wrongCount: async () => ({ ok: true, json: async () => ({ embeddings: [] }) }),
    wrongDims: async () => ({ ok: true, json: async () => ({ embeddings: [[1]] }) }),
    nan: async () => ({ ok: true, json: async () => ({ embeddings: [[Number.NaN, 0]] }) }),
  };
  let behavior = 'ok';
  const fetchImpl = async (_url, options) => {
    if (behavior !== 'ok') return behaviors[behavior]();
    return { ok: true, json: async () => ({ embeddings: JSON.parse(options.body).input.map(() => [1, 0]) }) };
  };
  const f = await fixture(t, { files: { 'answer.md': markdown('Answer', 'needle lexical evidence') }, fetchImpl });
  f.config.retrieval.abstainThreshold = 0;
  await connectSemanticIndex(f, fetchImpl);
  const client = await f.connect(f.config, f.stateDir, fetchImpl);
  const logged = [];
  const oldLog = console.log, oldError = console.error;
  console.log = (...values) => logged.push(values.join(' '));
  console.error = (...values) => logged.push(values.join(' '));
  try {
    for (const name of Object.keys(behaviors)) {
      behavior = name;
      const response = await call(client, 'wiki_query', { query: 'needle ' + marker });
      const result = payload(response);
      assert.ok(result.results.some(row => row.path === 'answer.md'), name);
      assert.equal(result.semantic.fallbackReason, 'provider-error', name);
      assert.ok(!JSON.stringify(response).includes(marker), name + ' leaked the query/provider error');
    }
  } finally {
    console.log = oldLog; console.error = oldError;
  }
  assert.ok(!logged.join('\n').includes(marker), 'provider failures leaked a synthetic query into logs');
  assert.ok(!logged.join('\n').includes('needle lexical evidence'), 'provider failures logged Wiki page text');
  behavior = 'ok';
});

test('fingerprint mismatch avoids embedding and returns the lexical answer', async t => {
  let calls = 0;
  const fetchImpl = async (_url, options) => ({ ok: true, json: async () => ({ embeddings: JSON.parse(options.body).input.map(() => [1, 0]) }) });
  const f = await fixture(t, { files: { 'answer.md': markdown('Answer', 'needle lexical evidence') }, fetchImpl });
  await connectSemanticIndex(f, fetchImpl);
  const changed = structuredClone(f.config); changed.semantic.model = 'another-model';
  const client = await f.connect(changed, f.stateDir, async () => { calls++; throw new Error('unexpected'); });
  const result = payload(await call(client, 'wiki_query', { query: 'needle' }));
  assert.equal(result.semantic.fallbackReason, 'fingerprint-mismatch');
  assert.ok(result.results.some(row => row.path === 'answer.md'));
  assert.equal(calls, 0);
});

test('remote endpoint policy rejects canonical and obfuscated remote hosts before fetch, and permits explicit opt-in', async t => {
  const rejected = [
    'http://example.test', 'http://192.0.2.15', 'http://[2001:4860:4860::8888]',
    'http://localhost.evil.test', 'http://127.0.0.1@evil.test', 'http://3232235777',
    'http://0300.0250.0001.0001',
  ];
  let calls = 0;
  const fetchImpl = async (_url, options) => {
    calls++;
    return { ok: true, json: async () => ({ embeddings: JSON.parse(options.body).input.map(() => [1, 0]) }) };
  };
  const f = await fixture(t, { files: { 'answer.md': markdown('Answer', 'needle lexical evidence') }, fetchImpl });
  await connectSemanticIndex(f, fetchImpl);
  const before = calls;
  for (const baseUrl of rejected) {
    const cfg = structuredClone(f.config); cfg.semantic.baseUrl = baseUrl;
    const validation = validateConfig(cfg);
    assert.equal(validation.ok, false, baseUrl);
    const client = await f.connect(cfg, f.stateDir, fetchImpl);
    const response = await call(client, 'wiki_query', { query: 'needle' });
    const result = payload(response);
    assert.ok(result.results.some(row => row.path === 'answer.md'));
    assert.ok(['remote-not-allowed', 'provider-error'].includes(result.semantic.fallbackReason), baseUrl);
    assert.ok(!JSON.stringify(response).includes(baseUrl), 'endpoint leaked in response');
  }
  assert.equal(calls, before, 'rejected hosts must never receive a request');

  for (const baseUrl of ['http://127.0.0.1:11434', 'http://localhost:11434', 'http://[::1]:11434']) {
    const cfg = structuredClone(f.config); cfg.semantic.baseUrl = baseUrl;
    assert.equal(validateConfig(cfg).ok, true, baseUrl);
  }
  const allowed = structuredClone(f.config); allowed.semantic.baseUrl = 'http://example.test'; allowed.semantic.allowRemote = true;
  assert.equal(validateConfig(allowed).ok, true);
  const client = await f.connect(allowed, f.stateDir, fetchImpl);
  const result = payload(await call(client, 'wiki_query', { query: 'needle' }));
  assert.equal(result.semantic.used, true);
  assert.ok(calls > before);
});

test('semantic write refresh is detached from wiki_write_page and refresh errors do not fail the write', async t => {
  let block = false, started;
  const began = new Promise(resolve => { started = resolve; });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const fetchImpl = async (_url, options) => {
    const inputs = JSON.parse(options.body).input;
    if (block && inputs.some(text => text.includes('newpagecontent'))) {
      started(); await gate; throw new Error(secret());
    }
    return { ok: true, json: async () => ({ embeddings: inputs.map(() => [1, 0]) }) };
  };
  const f = await fixture(t, { files: { 'answer.md': markdown('Answer', 'needle lexical evidence') }, fetchImpl });
  await connectSemanticIndex(f, fetchImpl);
  block = true;
  const client = await f.connect(f.config, f.stateDir, fetchImpl);
  const response = await Promise.race([
    call(client, 'wiki_write_page', { path: 'entities/new.md', content: markdown('New', 'newpagecontent') }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('wiki_write_page waited for semantic refresh')), 300)),
  ]);
  assert.notEqual(response.isError, true, response.content?.[0]?.text);
  assert.equal(JSON.parse(response.content[0].text).written, true);
  await began;
  release();
  assert.match(await readFile(join(f.wiki, 'entities/new.md'), 'utf8'), /newpagecontent/u);
});

