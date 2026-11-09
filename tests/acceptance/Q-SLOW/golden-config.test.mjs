// SPDX-License-Identifier: MIT
// Acceptance (9) golden/byte-compat for fast providers, (10) config, (11) unchanged hook and wiki_query paths.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../../packages/mcp/src/index.mjs';
import { createSearcher } from '../../../packages/core/src/retrieval/index.mjs';
import { CONFIG_SCHEMA, SEMANTIC_DEFAULTS, defaultConfig, loadConfig, resolvePaths, saveConfig, setConfigValue, validateConfig } from '@brainatlas/core';
import { commands, createOllamaProvider, markdownChunks, updateSemanticIndex, buildSemanticIndex } from '../../../modules/semantic/src/index.mjs';
import { fakeClock, normalizedIndexText, sectionPage, sha256, tempRoot, workspace } from './helpers.mjs';

// ---------------- golden (9) ----------------
const FILES = {
  'a.md': '# Alpha\n\n## One\nalpha one text\n\n## Two\nalpha two text\n',
  'b.md': '---\ntype: entity\n---\n# Beta\nbeta body only\n',
  'c.md': 'plain text without heading\n',
  'sub/d.md': '# Delta\n\n## Deep\ndelta deep text\n',
};
const VECTORS = {
  'alpha one text': [0.1, 0.2, 0.3], 'alpha two text': [0.4, 0.5, 0.6], 'beta body only': [0.7, 0.8, 0.9],
  'plain text without heading': [1, 0, 0], 'delta deep text': [0, 1, 0],
};
const id = (path, headingPath, text) => sha256(`${path}\u001f${headingPath}\u001f0\u001f${text}`).slice(0, 32);
function goldenText() {
  const chunk = (path, title, headingPath, text) => ({ id: id(path, headingPath, text), path, title, headingPath, text, vector: VECTORS[text] });
  const entries = [
    chunk('a.md', 'Alpha', 'Alpha > One', 'alpha one text'), chunk('a.md', 'Alpha', 'Alpha > Two', 'alpha two text'),
    chunk('b.md', 'Beta', 'Beta', 'beta body only'), chunk('c.md', 'c', '', 'plain text without heading'),
    chunk('sub/d.md', 'Delta', 'Delta > Deep', 'delta deep text'),
  ];
  const fileHashes = Object.fromEntries(['a.md', 'b.md', 'c.md', 'sub/d.md'].map(name => [name, sha256(FILES[name])]));
  return `${JSON.stringify({ version: 1, providerId: 'golden:model', providerFingerprint: 'golden-fp', preprocessVersion: '1', dims: 3, createdAt: '<redacted>', fileHashes, entries })}\n`;
}
function goldenProvider(sizes = []) {
  return { id: 'golden:model', dims: 3, fingerprint: 'golden-fp', async embedDocuments(texts) { sizes.push(texts.length); return texts.map(text => VECTORS[text]); } };
}

test('fast provider: index.json is byte-identical to the hand-built golden file (createdAt aside) and was embedded in one call', async t => {
  const w = await workspace(t, FILES);
  const sizes = [];
  await updateSemanticIndex({ corpusDir: w.wiki, stateDir: w.stateDir, provider: goldenProvider(sizes), chunkMarkdown: markdownChunks });
  const actual = await readFile(join(w.semanticDir, 'index.json'), 'utf8');
  assert.equal(normalizedIndexText(actual), goldenText());
  assert.match(JSON.parse(actual).createdAt, /^\d{4}-\d\d-\d\dT[\d:.]+Z$/u);
  assert.deepEqual(sizes, [5], 'five chunks, one group, same request shape as before');
  assert.deepEqual((await readdir(w.semanticDir)).sort(), ['index.json'], 'no partial or lock left behind');
});

test('forced rebuild and a second run over unchanged files give the same golden bytes', async t => {
  const w = await workspace(t, FILES);
  const options = { corpusDir: w.wiki, stateDir: w.stateDir, provider: goldenProvider(), chunkMarkdown: markdownChunks };
  await buildSemanticIndex(options);
  assert.equal(normalizedIndexText(await readFile(join(w.semanticDir, 'index.json'), 'utf8')), goldenText());
  await updateSemanticIndex({ ...options, skipUnchangedWrite: true });
  assert.equal(normalizedIndexText(await readFile(join(w.semanticDir, 'index.json'), 'utf8')), goldenText());
  await buildSemanticIndex({ ...options, indexBatchSize: 2 });
  assert.equal(normalizedIndexText(await readFile(join(w.semanticDir, 'index.json'), 'utf8')), goldenText(), 'group size does not influence the index bytes');
});

test('fast provider with more than 32 chunks: identical bytes whatever the group size, and Ollama request bodies are the legacy 32-per-request splits', async t => {
  const files = { 'big.md': sectionPage('Big', 70) };
  const bodies = [];
  const fetchImpl = async (_url, request) => { const body = JSON.parse(request.body); bodies.push(body); return { ok: true, json: async () => ({ embeddings: body.input.map(text => [text.length % 7, 1]) }) }; };
  const build = async (extra, label) => {
    const w = await workspace(t, files);
    bodies.length = 0;
    const provider = createOllamaProvider({ model: 'm', dims: 2, fetchImpl, documentPrefix: 'doc: ', batchSize: extra.indexBatchSize ?? 32, timeoutMs: 120000 });
    await updateSemanticIndex({ corpusDir: w.wiki, stateDir: w.stateDir, provider, chunkMarkdown: markdownChunks, ...extra });
    return { text: normalizedIndexText(await readFile(join(w.semanticDir, 'index.json'), 'utf8')), inputs: bodies.map(body => body.input) , label };
  };
  const reference = await build({}, 'default');
  assert.deepEqual(reference.inputs.map(group => group.length), [32, 32, 6], 'same as the legacy provider-side 32 splitting');
  assert.ok(reference.inputs.flat().every(text => text.startsWith('doc: ')), 'documentPrefix still applied');
  for (const size of [1, 7, 16, 32, 64]) {
    const other = await build({ indexBatchSize: size }, String(size));
    assert.equal(other.text, reference.text, `indexBatchSize ${size}`);
    assert.deepEqual(other.inputs.flat(), reference.inputs.flat(), 'same texts in the same order');
  }
});

test('semanticIndex and semanticStatus command outputs keep their keys (status gains only partialChunks)', async t => {
  const w = await workspace(t, FILES);
  const config = defaultConfig('custom'); config.vault.path = w.vault; config.modules = ['semantic'];
  config.semantic = { ...SEMANTIC_DEFAULTS, dims: 2, model: 'm' };
  const fetchImpl = async (_u, request) => ({ ok: true, json: async () => ({ embeddings: JSON.parse(request.body).input.map(() => [1, 0]) }) });
  const ctx = { config, env: { HOME: w.root }, paths: { stateDir: w.stateDir }, fetchImpl };
  const indexed = await commands.semanticIndex([], ctx);
  assert.deepEqual(indexed, { indexed: 4 });
  assert.deepEqual(Object.keys(indexed), ['indexed']);
  const status = await commands.semanticStatus([], ctx);
  assert.deepEqual(Object.keys(status).sort(), ['ageSeconds', 'enabled', 'fingerprintMatches', 'indexed', 'missing', 'model', 'partialChunks', 'stale']);
  assert.deepEqual({ enabled: status.enabled, model: status.model, indexed: status.indexed, stale: status.stale, missing: status.missing, fingerprintMatches: status.fingerprintMatches, partialChunks: status.partialChunks }, { enabled: false, model: 'm', indexed: 4, stale: 0, missing: 0, fingerprintMatches: true, partialChunks: 0 });
  assert.equal(typeof status.ageSeconds, 'number');
  assert.deepEqual(commands.semanticStatus([]), { enabled: false, gatePassed: false }, 'no-ctx form unchanged');
});

// ---------------- config (10) ----------------
const base = () => defaultConfig('custom');
const withSemantic = semantic => { const cfg = base(); cfg.semantic = semantic; return cfg; };

test('defaults: schemaVersion stays 1 and the two new keys carry the documented defaults', () => {
  assert.equal(base().schemaVersion, 1);
  assert.equal(SEMANTIC_DEFAULTS.indexTimeoutMs, 120000);
  assert.equal(SEMANTIC_DEFAULTS.indexBatchSize, 32);
  assert.equal(SEMANTIC_DEFAULTS.timeoutMs, 5000, 'query timeout default unchanged');
  assert.equal(Object.isFrozen(SEMANTIC_DEFAULTS), true);
  assert.equal(base().semantic.indexTimeoutMs, 120000);
  assert.equal(base().semantic.indexBatchSize, 32);
  assert.equal(validateConfig(base()).ok, true);
  assert.equal(CONFIG_SCHEMA.properties.semantic.properties.indexBatchSize.maximum, 64);
});

test('old configs without the new keys remain valid and load with defaults merged in', async t => {
  const old = base();
  const { indexTimeoutMs, indexBatchSize, ...legacy } = old.semantic;
  old.semantic = legacy;
  assert.equal(validateConfig(old).ok, true);
  const noSemantic = base(); delete noSemantic.semantic;
  assert.equal(validateConfig(noSemantic).ok, true);
  const root = await tempRoot(t);
  const paths = resolvePaths({ platform: 'linux', env: { HOME: root, XDG_CONFIG_HOME: join(root, 'c'), XDG_DATA_HOME: join(root, 'd'), XDG_STATE_HOME: join(root, 's') } });
  await mkdir(join(paths.configFile, '..'), { recursive: true });
  await writeFile(paths.configFile, JSON.stringify(old, null, 2));
  const loaded = await loadConfig({ paths, env: {} });
  assert.equal(loaded.semantic.indexTimeoutMs, 120000);
  assert.equal(loaded.semantic.indexBatchSize, 32);
  assert.equal(loaded.semantic.timeoutMs, 5000);
  await writeFile(paths.configFile, JSON.stringify({ ...noSemantic }, null, 2));
  assert.equal((await loadConfig({ paths, env: {} })).semantic.indexBatchSize, 32);
});

test('indexTimeoutMs validation: positive integers accepted, everything else rejected', () => {
  for (const good of [1, 2, 5000, 120000, 3_600_000, Number.MAX_SAFE_INTEGER]) assert.equal(validateConfig(withSemantic({ ...SEMANTIC_DEFAULTS, indexTimeoutMs: good })).ok, true, String(good));
  for (const bad of [0, -1, 0.5, 1.5, '5000', null, true, [], {}, NaN, Infinity]) {
    const result = validateConfig(withSemantic({ ...SEMANTIC_DEFAULTS, indexTimeoutMs: bad }));
    assert.equal(result.ok, false, String(bad));
    assert.ok(result.errors.some(error => error.path === 'semantic.indexTimeoutMs'), String(bad));
  }
});

test('indexBatchSize validation: integers 1..64 only', () => {
  for (const good of [1, 2, 32, 63, 64]) assert.equal(validateConfig(withSemantic({ ...SEMANTIC_DEFAULTS, indexBatchSize: good })).ok, true, String(good));
  for (const bad of [0, -1, 65, 100, 1.5, '32', null, false, NaN, Infinity]) {
    const result = validateConfig(withSemantic({ ...SEMANTIC_DEFAULTS, indexBatchSize: bad }));
    assert.equal(result.ok, false, String(bad));
    assert.ok(result.errors.some(error => error.path === 'semantic.indexBatchSize'), String(bad));
  }
  assert.equal(validateConfig(withSemantic({ ...SEMANTIC_DEFAULTS, indexBatch: 8 })).ok, false, 'unknown semantic keys remain rejected');
});

test('setConfigValue and saveConfig enforce the new ranges', async t => {
  const cfg = base();
  assert.equal(setConfigValue(cfg, 'semantic.indexBatchSize', 64).semantic.indexBatchSize, 64);
  assert.equal(setConfigValue(cfg, 'semantic.indexTimeoutMs', 1).semantic.indexTimeoutMs, 1);
  assert.throws(() => setConfigValue(cfg, 'semantic.indexBatchSize', 65), { code: 'E_CONFIG_INVALID' });
  assert.throws(() => setConfigValue(cfg, 'semantic.indexBatchSize', 0), { code: 'E_CONFIG_INVALID' });
  assert.throws(() => setConfigValue(cfg, 'semantic.indexTimeoutMs', 0), { code: 'E_CONFIG_INVALID' });
  assert.throws(() => setConfigValue(cfg, 'semantic.indexTimeoutMs', '9'), { code: 'E_CONFIG_INVALID' });
  const legacy = base(); const { indexBatchSize, indexTimeoutMs, ...rest } = legacy.semantic; legacy.semantic = rest;
  assert.equal(setConfigValue(legacy, 'semantic.indexBatchSize', 8).semantic.indexBatchSize, 8, 'settable on a legacy config');
  const root = await tempRoot(t);
  const paths = { configFile: join(root, 'config.json') };
  await assert.rejects(saveConfig(withSemantic({ ...SEMANTIC_DEFAULTS, indexBatchSize: 65 }), { paths }), { code: 'E_CONFIG_INVALID' });
  await saveConfig(withSemantic({ ...SEMANTIC_DEFAULTS, indexBatchSize: 64, indexTimeoutMs: 1 }), { paths });
  assert.equal(JSON.parse(await readFile(paths.configFile, 'utf8')).semantic.indexBatchSize, 64);
});

test('provider fingerprint and existing index validity are independent of the two new settings', async t => {
  const w = await workspace(t, FILES);
  const config = defaultConfig('custom'); config.vault.path = w.vault; config.modules = ['semantic'];
  config.semantic = { ...SEMANTIC_DEFAULTS, dims: 2, model: 'm' };
  const fetchImpl = async (_u, request) => ({ ok: true, json: async () => ({ embeddings: JSON.parse(request.body).input.map(() => [1, 0]) }) });
  const ctx = (semantic) => ({ config: { ...config, semantic: { ...config.semantic, ...semantic } }, env: { HOME: w.root }, paths: { stateDir: w.stateDir }, fetchImpl });
  await commands.semanticIndex([], ctx({}));
  for (const semantic of [{ indexTimeoutMs: 1 }, { indexTimeoutMs: 999999 }, { indexBatchSize: 1 }, { indexBatchSize: 64 }, { timeoutMs: 1 }]) {
    const status = await commands.semanticStatus([], ctx(semantic));
    assert.equal(status.fingerprintMatches, true, JSON.stringify(semantic));
    assert.equal(status.stale, 0);
  }
  let calls = 0;
  const counting = async (...args) => { calls++; return fetchImpl(...args); };
  await commands.semanticIndex([], { ...ctx({ indexBatchSize: 8, indexTimeoutMs: 77777 }), fetchImpl: counting });
  assert.equal(calls, 0, 'changing the new settings does not invalidate or rebuild the index');
  const different = createOllamaProvider({ ...SEMANTIC_DEFAULTS, model: 'other', dims: 2, fetchImpl });
  const same = createOllamaProvider({ ...SEMANTIC_DEFAULTS, model: 'm', dims: 2, fetchImpl });
  assert.notEqual(different.fingerprint, same.fingerprint, 'sanity: model still changes the fingerprint');
});

test('invalid semantic index settings are refused by the commands without calling the provider', async t => {
  const w = await workspace(t, FILES);
  const config = defaultConfig('custom'); config.vault.path = w.vault;
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error('must not be called'); };
  for (const semantic of [{ indexBatchSize: 0 }, { indexBatchSize: 65 }, { indexTimeoutMs: 0 }]) {
    config.semantic = { ...SEMANTIC_DEFAULTS, dims: 2, model: 'm', ...semantic };
    await assert.rejects(commands.semanticIndex([], { config, env: { HOME: w.root }, paths: { stateDir: w.stateDir }, fetchImpl }), undefined, JSON.stringify(semantic));
  }
  assert.equal(calls, 0);
});

// ---------------- hook path and wiki_query (11) ----------------
test('the hook sources do not depend on the semantic module or the new settings', async () => {
  const dir = new URL('../../../packages/hooks/src/', import.meta.url).pathname;
  for (const name of await readdir(dir)) {
    const source = await readFile(join(dir, name), 'utf8');
    assert.doesNotMatch(source, /semantic|indexTimeoutMs|indexBatchSize|index\.partial|index\.lock/u, name);
  }
});

async function mcpFixture(t, files, config) {
  const w = await workspace(t, files);
  const paths = { stateDir: w.stateDir, releasesDir: join(w.root, 'releases'), currentDir: join(w.root, 'current') };
  const release = join(paths.releasesDir, 'v1');
  await mkdir(join(release, 'modules'), { recursive: true });
  const repo = new URL('../../../', import.meta.url).pathname;
  await cp(join(repo, 'modules/semantic'), join(release, 'modules/semantic'), { recursive: true });
  await symlink(join(repo, 'packages'), join(release, 'packages'));
  await symlink(release, paths.currentDir);
  config.vault.path = w.vault;
  const connect = async fetchImpl => {
    const server = createServer({ config, paths, env: { HOME: w.root }, fetchImpl });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'q-slow', version: '1' });
    await Promise.all([server.connect(b), client.connect(a)]);
    t.after(async () => { await client.close(); await server.close(); });
    return client;
  };
  return { w, connect };
}
const queryOf = async (client, query) => JSON.parse((await client.callTool({ name: 'wiki_query', arguments: { query } })).content[0].text);
const page = (title, body) => `---\ntype: entity\ntitle: ${title}\nstatus: active\n---\n# ${title}\n${body}\n`;

test('wiki_query keeps its lexical golden shape with semantic disabled, even with stale lock and partial files in state', async t => {
  const config = base(); config.modules = ['semantic']; config.semantic = { ...SEMANTIC_DEFAULTS, enabled: false, dims: 2 };
  const { w, connect } = await mcpFixture(t, { 'one.md': page('One', 'violetneedle evidence'), 'index.md': '# Wiki Index\n', 'log.md': '# Log\n' }, config);
  const golden = createSearcher({ vaultDir: w.wiki, stateDir: w.stateDir }).search('violetneedle', { limit: 5, budgetChars: 4000, abstainThreshold: 0.35 });
  await mkdir(w.semanticDir, { recursive: true });
  await writeFile(join(w.semanticDir, 'index.lock'), JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
  await writeFile(join(w.semanticDir, 'index.partial.json'), '{"junk":true}');
  let calls = 0;
  const client = await connect(async () => { calls++; throw new Error('no provider call expected'); });
  const answer = await queryOf(client, 'violetneedle');
  assert.deepEqual(answer, { results: golden.results, abstained: golden.abstained });
  assert.equal(calls, 0);
});

test('wiki_query with semantic enabled keeps its response shape using an index built by the new code', async t => {
  const config = base(); config.modules = ['semantic']; config.semantic = { ...SEMANTIC_DEFAULTS, enabled: true, dims: 2, model: 'm' };
  const { w, connect } = await mcpFixture(t, { 'one.md': page('One', 'violetneedle evidence'), 'two.md': page('Two', 'unrelated filler'), 'index.md': '# Wiki Index\n', 'log.md': '# Log\n' }, config);
  const fetchImpl = async (_u, request) => ({ ok: true, json: async () => ({ embeddings: JSON.parse(request.body).input.map(text => (/violetneedle/u.test(text) || /query: violetneedle/u.test(text)) ? [1, 0] : [0, 1]) }) });
  await updateSemanticIndex({ corpusDir: w.wiki, stateDir: w.stateDir, provider: createOllamaProvider({ ...config.semantic, fetchImpl }), chunkMarkdown: markdownChunks });
  const client = await connect(fetchImpl);
  const answer = await queryOf(client, 'violetneedle');
  assert.deepEqual(Object.keys(answer).sort(), ['abstained', 'mode', 'results', 'semantic']);
  assert.deepEqual(answer.semantic, { used: true });
  assert.equal(answer.mode, 'semantic-primary');
  assert.equal(answer.results[0].path, 'one.md');
  for (const key of ['path', 'title', 'score', 'snippet']) assert.ok(key in answer.results[0], key);
});

test('wiki_query ignores a partial file: with only a partial present it reports index-missing and serves BM25 results', async t => {
  const config = base(); config.modules = ['semantic']; config.semantic = { ...SEMANTIC_DEFAULTS, enabled: true, dims: 2, model: 'm' };
  const { w, connect } = await mcpFixture(t, { 'one.md': page('One', 'violetneedle evidence'), 'index.md': '# Wiki Index\n', 'log.md': '# Log\n' }, config);
  const lexical = createSearcher({ vaultDir: w.wiki, stateDir: w.stateDir }).search('violetneedle', { limit: 5, budgetChars: 4000, abstainThreshold: 0.35 });
  const fetchImpl = async () => { throw new Error('provider unavailable'); };
  const provider = createOllamaProvider({ ...config.semantic, fetchImpl });
  const chunk = markdownChunks(await readFile(join(w.wiki, 'one.md'), 'utf8'), 'one.md')[0];
  await mkdir(w.semanticDir, { recursive: true });
  const partialText = `${JSON.stringify({ version: 1, providerFingerprint: provider.fingerprint, dims: 2, preprocessVersion: '1', vectors: { [sha256(chunk.text)]: [1, 0] } })}\n`;
  await writeFile(join(w.semanticDir, 'index.partial.json'), partialText);
  const client = await connect(fetchImpl);
  const answer = await queryOf(client, 'violetneedle');
  assert.deepEqual(answer.results, lexical.results);
  assert.equal(answer.semantic.used, false);
  assert.equal(answer.semantic.fallbackReason, 'index-missing');
  assert.equal(await readFile(join(w.semanticDir, 'index.partial.json'), 'utf8'), partialText, 'query path did not modify the partial file');
});
