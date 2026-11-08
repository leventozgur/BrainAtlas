// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createOllamaProvider, PREPROCESS_VERSION } from '../../../modules/semantic/src/provider.mjs';
import { buildSemanticIndex, readSemanticIndex } from '../../../modules/semantic/src/index-store.mjs';
import { markdownChunks } from '../../../modules/semantic/src/chunking.mjs';
import { searchHybrid } from '../../../modules/semantic/src/hybrid.mjs';

const makeSecret = () => ['sk', 'test' + 'x'.repeat(24)].join('-');
const page = (file, body, frontmatter = {}) => ({ path: file, title: file, aliases: [], keywords: [], headings: [], body, frontmatter });
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'q-semeval-provider-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const corpus = path.join(root, 'corpus');
  const state = path.join(root, 'state');
  await mkdir(corpus);
  await mkdir(state);
  return { root, corpus, state };
}

test('Ollama query and document prefixes stay separate; legacy embed body stays unchanged', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options, body: JSON.parse(options.body) });
    return { ok: true, json: async () => ({ embeddings: requests.at(-1).body.input.map(() => [1, 0]) }) };
  };
  const provider = createOllamaProvider({ model: 'local-test', dims: 2, queryPrefix: 'Q: ', documentPrefix: 'D: ', fetchImpl });

  assert.deepEqual(Array.from(await provider.embedQuery('find this')), [1, 0]);
  await provider.embedDocuments(['first', 'second']);
  await provider.embed(['plain']);
  assert.deepEqual(requests.map(({ body }) => body.input), [['Q: find this'], ['D: first', 'D: second'], ['plain']]);
  assert.deepEqual(requests.map(({ body }) => body.model), ['local-test', 'local-test', 'local-test']);
  assert.ok(requests.every(({ url }) => url === 'http://127.0.0.1:11434/api/embed'));

  const legacy = [];
  const oldProvider = createOllamaProvider({ model: 'local-test', dims: 2, fetchImpl: async (_url, options) => {
    legacy.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ embeddings: [[0, 1]] }) };
  } });
  await oldProvider.embed(['original']);
  assert.deepEqual(legacy, [{ model: 'local-test', input: ['original'] }]);
  assert.deepEqual(Array.from(await oldProvider.embedQuery('original')), [0, 1]);
  assert.deepEqual(legacy[1], { model: 'local-test', input: ['original'] });
});

test('batch size boundaries preserve input order and empty input makes no request', async (t) => {
  for (const scenario of [
    { name: 'size one', size: 1, values: ['0', '1', '2', '3', '4'], batches: 5 },
    { name: 'exact multiple', size: 5, values: ['0', '1', '2', '3', '4'], batches: 1 },
    { name: 'remainder', size: 2, values: ['0', '1', '2', '3', '4'], batches: 3 },
    { name: 'empty', size: 2, values: [], batches: 0 },
  ]) {
    await t.test(scenario.name, async () => {
      const requests = [];
      const provider = createOllamaProvider({ model: 'batch', dims: 2, batchSize: scenario.size, fetchImpl: async (_url, options) => {
        const input = JSON.parse(options.body).input;
        requests.push(input);
        return { ok: true, json: async () => ({ embeddings: input.map((value) => [Number(value), 1]) }) };
      } });
      const vectors = await provider.embed(scenario.values);
      assert.equal(requests.length, scenario.batches);
      assert.deepEqual(requests.flat(), scenario.values);
      assert.deepEqual(vectors.map((vector) => Array.from(vector)), scenario.values.map((value) => [Number(value), 1]));
      assert.deepEqual(await provider.embed([]), []);
      assert.equal(requests.length, scenario.batches);
    });
  }
  assert.throws(() => createOllamaProvider({ model: 'batch', batchSize: 0 }), { code: 'E_SEMANTIC_PROVIDER' });
  for (const value of [1.5, -1, '2']) assert.throws(() => createOllamaProvider({ model: 'batch', batchSize: value }), { code: 'E_SEMANTIC_PROVIDER' });
});

test('provider fingerprint is stable and covers model, dimensions, both prefixes and preprocessing version', () => {
  const make = (options = {}) => createOllamaProvider({ model: 'fingerprint-model', dims: 3, fetchImpl: async () => ({ ok: true, json: async () => ({ embeddings: [] }) }), ...options });
  const base = make({ queryPrefix: 'query: ', documentPrefix: 'passage: ' });
  const same = make({ queryPrefix: 'query: ', documentPrefix: 'passage: ' });
  const variants = [
    make({ model: 'other-model', queryPrefix: 'query: ', documentPrefix: 'passage: ' }),
    make({ dims: 4, queryPrefix: 'query: ', documentPrefix: 'passage: ' }),
    make({ queryPrefix: 'query: changed ', documentPrefix: 'passage: ' }),
    make({ queryPrefix: 'query: ', documentPrefix: 'passage: changed ' }),
  ];
  assert.equal(base.fingerprint, same.fingerprint);
  assert.match(base.fingerprint, /^[a-f0-9]{16}$/u);
  assert.equal(base.fingerprint, createHash('sha256').update(['fingerprint-model', 3, 'query: ', 'passage: ', PREPROCESS_VERSION].join('|')).digest('hex').slice(0, 16));
  assert.ok(variants.every(({ fingerprint }) => fingerprint !== base.fingerprint));
  const prefixAndDims = [make({ dims: 4, queryPrefix: 'query: ', documentPrefix: 'passage: ' }), make({ queryPrefix: 'changed ', documentPrefix: 'passage: ' })];
  assert.ok(prefixAndDims.every(({ id }) => id === base.id));
});

test('timeout and malformed provider responses raise content-free E_SEMANTIC_PROVIDER errors', async () => {
  const secret = makeSecret();
  const baseUrl = `http://127.0.0.1:11434/${secret}`;
  let signal;
  const slow = createOllamaProvider({ model: 'timeout-test', dims: 2, baseUrl, timeoutMs: 10, fetchImpl: async (_url, options) => {
    signal = options.signal;
    return new Promise(() => {});
  } });
  await assert.rejects(slow.embed([secret]), (error) => {
    assert.equal(error.code, 'E_SEMANTIC_PROVIDER');
    assert.ok(!String(error.message + error.stack).includes(secret));
    assert.ok(!String(error.message + error.stack).includes(baseUrl));
    return true;
  });
  assert.equal(signal.aborted, true);

  const slowJson = createOllamaProvider({ model: 'timeout-json', dims: 2, timeoutMs: 10, fetchImpl: async () => ({ ok: true, json: async () => new Promise(() => {}) }) });
  await assert.rejects(slowJson.embed([secret]), (error) => error.code === 'E_SEMANTIC_PROVIDER' && !String(error.message + error.stack).includes(secret));

  const bad = createOllamaProvider({ model: 'bad-response', dims: 2, fetchImpl: async () => ({ ok: true, json: async () => { throw new Error(secret); } }) });
  await assert.rejects(bad.embed([secret]), (error) => error.code === 'E_SEMANTIC_PROVIDER' && !String(error.message + error.stack).includes(secret));
  const wrongDims = createOllamaProvider({ model: 'bad-vector', dims: 2, fetchImpl: async () => ({ ok: true, json: async () => ({ embeddings: [[1]] }) }) });
  await assert.rejects(wrongDims.embed(['private prompt']), { code: 'E_SEMANTIC_PROVIDER' });
});

test('semantic index prefers embedDocuments and persists provider fingerprint and preprocess version', async (t) => {
  const { corpus, state } = await fixture(t);
  await writeFile(path.join(corpus, 'one.md'), '# One\nprivate searchable text');
  const seen = [];
  const provider = {
    id: 'fake-provider', dims: 2, fingerprint: 'fp-verified', preprocessVersion: 'preprocess-verified',
    embed: async () => { throw new Error('legacy embed must not be selected'); },
    embedDocuments: async (texts) => { seen.push(...texts); return texts.map(() => [1, 0]); },
  };
  const index = await buildSemanticIndex({ corpusDir: corpus, stateDir: state, provider, chunkMarkdown: markdownChunks });
  assert.deepEqual(seen, ['private searchable text']);
  assert.equal(index.providerFingerprint, 'fp-verified');
  assert.equal(index.preprocessVersion, 'preprocess-verified');
  assert.deepEqual(await readSemanticIndex(state), index);

  const legacyProvider = { id: 'legacy', dims: 2, embed: async (texts) => texts.map(() => [0, 1]) };
  const legacyState = path.join(state, 'legacy'); await mkdir(legacyState);
  const legacyIndex = await buildSemanticIndex({ corpusDir: corpus, stateDir: legacyState, provider: legacyProvider, chunkMarkdown: markdownChunks });
  assert.equal(legacyIndex.providerFingerprint, null);
  assert.equal(legacyIndex.preprocessVersion, PREPROCESS_VERSION);
});

test('fingerprint-less v1 index falls back lexically; matching and omitted metadata keep semantic retrieval', async (t) => {
  const pages = [page('alpha.md', 'quartz lexical hit'), page('beta.md', 'other text')];
  const entries = [
    { path: 'beta.md', text: 'semantic chunk text', headingPath: 'Evidence', vector: [1, 0] },
    { path: 'beta.md', text: 'lower semantic chunk', headingPath: 'Other', vector: [0.5, 0.5] },
  ];
  let calls = 0;
  const provider = { fingerprint: 'current-fingerprint', embedQuery: async () => { calls++; return [1, 0]; } };
  const root = await mkdtemp(path.join(tmpdir(), 'q-semeval-v1-index-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = path.join(root, 'state'); const semanticDir = path.join(state, 'semantic');
  await mkdir(semanticDir, { recursive: true });
  const legacyV1 = { version: 1, providerId: 'ollama:old', dims: 2, createdAt: new Date(0).toISOString(), fileHashes: {}, entries };
  await writeFile(path.join(semanticDir, 'index.json'), JSON.stringify(legacyV1));
  const persistedV1 = await readSemanticIndex(state);
  assert.deepEqual(persistedV1, legacyV1);
  const fallback = await searchHybrid({ query: 'quartz', pages, entries, provider, indexMeta: legacyV1 });
  assert.ok(Array.isArray(fallback));
  assert.deepEqual(fallback.map(({ path: file }) => file), ['alpha.md']);
  assert.equal(fallback.fallbackReason, 'fingerprint-mismatch');
  assert.equal(calls, 0);

  const matching = await searchHybrid({ query: 'quartz', pages, entries, provider, indexMeta: { ...persistedV1, providerFingerprint: provider.fingerprint } });
  assert.equal(matching.fallbackReason, undefined);
  assert.ok(matching.some(({ path: file }) => file === 'beta.md'));
  const semanticOnly = matching.find(({ path: file }) => file === 'beta.md');
  assert.equal(matching.filter(({ path: file }) => file === 'beta.md').length, 1);
  assert.equal(semanticOnly.snippet, 'semantic chunk text');
  assert.equal(semanticOnly.headingPath, 'Evidence');
  assert.equal(calls, 1);

  const legacyCall = await searchHybrid({ query: 'quartz', pages, entries, provider });
  assert.equal(legacyCall.fallbackReason, undefined);
  assert.ok(legacyCall.some(({ path: file }) => file === 'beta.md'));
});

test('provider errors and dimension mismatches fall back safely with a reason', async () => {
  const pages = [page('hit.md', 'quartz lexical hit')];
  const matchingMeta = { providerFingerprint: 'same' };
  const broken = await searchHybrid({ query: 'quartz', pages, entries: [], provider: { fingerprint: 'same', embedQuery: async () => { throw new Error(makeSecret()); } }, indexMeta: matchingMeta });
  assert.equal(broken.fallbackReason, 'provider-error');
  assert.equal(broken[0].path, 'hit.md');
  assert.ok(!JSON.stringify(broken).includes(makeSecret()));

  const wrongDimension = await searchHybrid({ query: 'quartz', pages, entries: [{ path: 'hit.md', vector: [1, 0, 0] }], provider: { fingerprint: 'same', embedQuery: async () => [1, 0] }, indexMeta: matchingMeta });
  assert.equal(wrongDimension.fallbackReason, 'provider-error');
  assert.deepEqual(wrongDimension.map(({ path: file }) => file), ['hit.md']);
});

test('corpus symlinks and traversal entries are excluded; owned semantic state rejects symlink targets', async (t) => {
  const { root, corpus, state } = await fixture(t);
  const secret = makeSecret();
  await writeFile(path.join(root, 'outside.md'), `# Outside\n${secret}`);
  await writeFile(path.join(corpus, 'inside.md'), '# Inside\nquartz');
  await symlink(path.join(root, 'outside.md'), path.join(corpus, 'linked.md'));
  const texts = [];
  const provider = { id: 'security', dims: 2, embedDocuments: async (values) => { texts.push(...values); return values.map(() => [1, 0]); } };
  const index = await buildSemanticIndex({ corpusDir: corpus, stateDir: state, provider, chunkMarkdown: markdownChunks });
  assert.deepEqual(Object.keys(index.fileHashes), ['inside.md']);
  assert.ok(texts.every((text) => !text.includes(secret)));

  const pages = [page('inside.md', 'quartz')];
  const results = await searchHybrid({ query: 'secretless', pages, entries: [{ path: '../outside.md', text: secret, vector: [1, 0] }], provider: { embed: async () => [[1, 0]] } });
  assert.ok(results.every(({ path: resultPath }) => resultPath !== '../outside.md'));
  assert.ok(!JSON.stringify(results).includes(secret));

  const outside = path.join(root, 'outside-state'); await mkdir(outside);
  await writeFile(path.join(outside, 'marker'), 'untouched');
  const stateWithSymlink = path.join(root, 'linked-state'); await mkdir(stateWithSymlink);
  await symlink(outside, path.join(stateWithSymlink, 'semantic'));
  await assert.rejects(buildSemanticIndex({ corpusDir: corpus, stateDir: stateWithSymlink, provider, chunkMarkdown: markdownChunks }));
  assert.deepEqual(await readdir(outside), ['marker']);
  assert.equal(await readFile(path.join(outside, 'marker'), 'utf8'), 'untouched');
});
