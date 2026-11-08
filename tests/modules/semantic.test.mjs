// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  activate, buildSemanticIndex, commands, configureSemantic, createOllamaProvider,
  cosineSimilarity, markdownChunks, measureIndexFreshness, readSemanticIndex,
  reciprocalRankFusion, searchHybrid, semanticGate, semanticStatus,
} from '../../modules/semantic/src/index.mjs';

async function temporary(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'semantic-tests-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function conceptProvider({ broken = false } = {}) {
  const concept = (text) => /\b(car|araba)\b/iu.test(text) ? [1, 0] : /\b(book|kitap)\b/iu.test(text) ? [0, 1] : [0, 0];
  return { id: 'deterministic-fake', dims: 2, healthy: async () => true,
    embed: async (texts) => texts.map((text) => Float32Array.from(broken && /araba/iu.test(text) ? [0, 1] : concept(text))) };
}

test('Ollama provider posts an input batch through injected fetch and validates vectors', async () => {
  let request;
  const provider = createOllamaProvider({ baseUrl: 'http://example.com:11434/', allowRemote: true, model: 'embedding-model', dims: 2,
    fetchImpl: async (url, options) => {
      request = { url, options };
      const input = JSON.parse(options.body).input;
      return { ok: true, json: async () => ({ embeddings: input.includes('secret prompt') ? [[1]] : [[1, 0], [0, 1]] }) };
    } });
  const vectors = await provider.embed(['alpha', 'beta']);
  assert.equal(request.url, 'http://example.com:11434/api/embed');
  assert.deepEqual(JSON.parse(request.options.body), { model: 'embedding-model', input: ['alpha', 'beta'] });
  assert.ok(vectors[0] instanceof Float32Array);
  assert.equal(provider.dims, 2);
  assert.equal(await provider.healthy(), true);
  await assert.rejects(provider.embed(['secret prompt']), { code: 'E_SEMANTIC_PROVIDER' });
});

test('Ollama provider marks failed health without exposing response content', async () => {
  const provider = createOllamaProvider({ model: 'embedding-model', dims: 2,
    fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({ body: 'private text' }) }) });
  await assert.rejects(provider.embed(['private text']), (error) => error.code === 'E_SEMANTIC_PROVIDER' && !error.message.includes('private'));
  assert.equal(await provider.healthy(), false);
});

test('heading-aware markdown chunking preserves section paths and excludes frontmatter', () => {
  const chunks = markdownChunks('---\ntitle: hidden\n---\n# Guide\nopening words\n## Setup\nconfigure system', 'guide.md', { maxWords: 2 });
  assert.equal(chunks[0].title, 'Guide');
  assert.equal(chunks[0].headingPath, 'Guide');
  assert.equal(chunks[1].headingPath, 'Guide > Setup');
  assert.ok(chunks.every((chunk) => !chunk.text.includes('hidden')));
});

test('local semantic index records per-file hashes and reports stale, missing, and age', async (t) => {
  const dir = await temporary(t), corpus = path.join(dir, 'corpus'), state = path.join(dir, 'state');
  await fs.mkdir(corpus);
  await fs.writeFile(path.join(corpus, 'one.md'), '# One\ncar transport');
  const index = await buildSemanticIndex({ corpusDir: corpus, stateDir: state, provider: conceptProvider(), chunkMarkdown: markdownChunks });
  assert.equal((await readSemanticIndex(state)).entries.length, 1);
  await fs.writeFile(path.join(corpus, 'one.md'), '# One\ncar transport changed');
  await fs.writeFile(path.join(corpus, 'two.md'), '# Two\nbook notes');
  const metric = await measureIndexFreshness({ corpusDir: corpus, index, now: new Date(Date.parse(index.createdAt) + 5000) });
  assert.deepEqual(metric, { indexed: 1, stale: 1, missing: 1, ageSeconds: 5 });
  assert.deepEqual(await fs.readdir(state), ['semantic']);
  assert.deepEqual(await fs.readdir(path.join(state, 'semantic')), ['index.json']);
});

test('semantic index rejects symlink descendants and treats corrupt JSON as a cache miss', async (t) => {
  const dir = await temporary(t), corpus = path.join(dir, 'corpus'), state = path.join(dir, 'state'), outside = path.join(dir, 'outside');
  await fs.mkdir(corpus); await fs.mkdir(outside);
  await fs.writeFile(path.join(corpus, 'one.md'), '# One\ncar transport');
  await fs.mkdir(state);
  await fs.symlink(outside, path.join(state, 'semantic'));
  await assert.rejects(buildSemanticIndex({ corpusDir: corpus, stateDir: state, provider: conceptProvider(), chunkMarkdown: markdownChunks }), { code: 'E_SEMANTIC_STATE' });
  assert.deepEqual(await fs.readdir(outside), []);

  await fs.rm(path.join(state, 'semantic'), { force: true });
  await fs.mkdir(path.join(state, 'semantic'));
  await fs.writeFile(path.join(state, 'semantic', 'index.json'), '{broken');
  assert.equal(await readSemanticIndex(state), null);
  const rebuilt = await buildSemanticIndex({ corpusDir: corpus, stateDir: state, provider: conceptProvider(), chunkMarkdown: markdownChunks });
  assert.equal((await readSemanticIndex(state)).entries.length, rebuilt.entries.length);
});

test('cosine similarity and RRF combine rankings deterministically with k=60 default', () => {
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  const fused = reciprocalRankFusion([
    [{ path: 'a.md' }, { path: 'b.md' }],
    [{ path: 'b.md' }, { path: 'a.md' }],
  ]);
  assert.equal(fused[0].rrfScore, 1 / 61 + 1 / 62);
  assert.deepEqual(fused.map((item) => item.path), ['a.md', 'b.md']);
});

test('hybrid search fuses core BM25F with semantic ranks', async () => {
  const pages = [{ path: 'car.md', title: 'Transport', aliases: [], keywords: [], headings: [], body: 'car transport', frontmatter: {} }];
  const entries = [{ path: 'car.md', title: 'Transport', vector: [1, 0] }];
  const results = await searchHybrid({ query: 'araba', pages, entries, provider: conceptProvider() });
  assert.equal(results[0].path, 'car.md');
  assert.equal(results[0].sourceRanks[0], 1);
});

test('hybrid search falls back to lexical results when the semantic provider fails', async () => {
  const pages = [{ path: 'car.md', title: 'Car', aliases: [], keywords: [], headings: [], body: 'car transport', frontmatter: {} }];
  const results = await searchHybrid({ query: 'car', pages, entries: [], provider: { embed: async () => { throw Object.assign(new Error('provider failed'), { code: 'E_SEMANTIC_PROVIDER' }); } } });
  assert.deepEqual(results.map(({ path }) => path), ['car.md']);
});

test('hybrid semantic candidates obey core path and OKF filters and carry stale status', async () => {
  const pages = [
    { path: 'valid.md', title: 'Valid', aliases: [], keywords: [], headings: [], body: 'unmatched', frontmatter: { stale_after: '2000-01-01', status: 'confirmed' } },
    { path: 'superseded.md', title: 'Superseded', aliases: [], keywords: [], headings: [], body: '', frontmatter: { status: 'superseded' } },
    { path: 'targeted.md', title: 'Targeted', aliases: [], keywords: [], headings: [], body: '', frontmatter: { superseded_by: 'wiki/new.md' } },
    { path: '../outside.md', title: 'Outside', aliases: [], keywords: [], headings: [], body: '', frontmatter: {} },
    { path: '/absolute.md', title: 'Absolute', aliases: [], keywords: [], headings: [], body: '', frontmatter: {} },
  ];
  const entries = pages.map(({ path, title }) => ({ path, title, vector: [1, 0] }));
  const results = await searchHybrid({ query: 'no lexical hit', pages, entries, provider: { embed: async () => [[1, 0]] } });
  assert.deepEqual(results.map(({ path }) => path), ['valid.md']);
  assert.equal(results[0].stale, true);
  assert.equal(results[0].status, 'confirmed');
});

test('semantic gate passes only with the specified Turkish recall gain and precision bound', async (t) => {
  const dir = await temporary(t), corpus = path.join(dir, 'corpus');
  await fs.mkdir(corpus);
  await fs.writeFile(path.join(corpus, 'car.md'), '# Transport\ncar transport');
  await fs.writeFile(path.join(corpus, 'book.md'), '# Reading\nbook notes');
  const devCases = [
    { id: 'turkish-car', query: 'araba', relevant: ['car.md'], trToEn: true },
    { id: 'english-book', query: 'book notes', relevant: ['book.md'] },
  ];
  const passed = await semanticGate({ devCases, corpusDir: corpus, provider: conceptProvider() });
  assert.equal(passed.enable, true);
  assert.ok(passed.trToEnDelta >= 0.1);
  assert.ok(passed.precisionDelta >= -0.05);
  const failed = await semanticGate({ devCases, corpusDir: corpus, provider: conceptProvider({ broken: true }) });
  assert.equal(failed.enable, false);
  assert.ok(failed.trToEnDelta < 0.1);
});

test('module remains disabled until evaluation passes and user opts in', async () => {
  await activate({ config: { semantic: { enabled: true } } });
  assert.deepEqual(semanticStatus(), { enabled: false, gatePassed: false });
  assert.equal(configureSemantic({ gateResult: { enable: true }, optIn: false }), false);
  assert.deepEqual(commands.semanticStatus(), { enabled: false, gatePassed: true });
  assert.equal(configureSemantic({ gateResult: { enable: true }, optIn: true }), true);
  assert.deepEqual(semanticStatus(), { enabled: true, gatePassed: true });
  configureSemantic({ gateResult: { enable: false }, optIn: true });
  assert.deepEqual(semanticStatus(), { enabled: false, gatePassed: false });
});

test('incremental indexing embeds only changed chunks, drops deleted files and rebuilds invalid caches', async t => {
  const { updateSemanticIndex } = await import('../../modules/semantic/src/index.mjs');
  const dir = await temporary(t), corpusDir = path.join(dir, 'wiki'), stateDir = path.join(dir, 'state');
  await fs.mkdir(corpusDir);
  await fs.writeFile(path.join(corpusDir, 'one.md'), '# One\nfirst');
  await fs.writeFile(path.join(corpusDir, 'two.md'), '# Two\nsecond');
  let embedded = [];
  const provider = { id: 'fake', dims: 2, fingerprint: 'a', embedDocuments: async texts => { embedded.push(...texts); return texts.map(() => [1, 0]); } };
  const options = { corpusDir, stateDir, provider, chunkMarkdown: markdownChunks };
  await updateSemanticIndex(options); assert.equal(embedded.length, 2);
  embedded = []; await fs.writeFile(path.join(corpusDir, 'one.md'), '# One\nchanged');
  await fs.rm(path.join(corpusDir, 'two.md'));
  let index = await updateSemanticIndex(options);
  assert.equal(embedded.length, 1); assert.match(embedded[0], /changed/); assert.deepEqual(Object.keys(index.fileHashes), ['one.md']);
  await fs.writeFile(path.join(corpusDir, 'two.md'), '# Two\nsecond');
  embedded = []; provider.fingerprint = 'b'; await updateSemanticIndex(options); assert.equal(embedded.length, 2);
  await fs.writeFile(path.join(stateDir, 'semantic/index.json'), '{broken');
  embedded = []; index = await updateSemanticIndex(options); assert.equal(embedded.length, 2); assert.equal(index.entries.length, 2);
});

test('concurrent updates share one indexing operation', async t => {
  const { updateSemanticIndex } = await import('../../modules/semantic/src/index.mjs');
  const dir = await temporary(t), corpusDir = path.join(dir, 'wiki'), stateDir = path.join(dir, 'state');
  await fs.mkdir(corpusDir); await fs.writeFile(path.join(corpusDir, 'one.md'), '# One\ncontent');
  let calls = 0, release; const gate = new Promise(resolve => { release = resolve; });
  const provider = { id: 'fake', dims: 2, fingerprint: 'a', embedDocuments: async texts => { calls++; await gate; return texts.map(() => [1, 0]); } };
  const options = { corpusDir, stateDir, provider, chunkMarkdown: markdownChunks };
  const a = updateSemanticIndex(options), b = updateSemanticIndex(options); assert.equal(a, b); release();
  await Promise.all([a, b]); assert.equal(calls, 1);
});

test('configured commands reject remote providers while the standalone provider remains unrestricted', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return { ok: true, json: async () => ({ embeddings: [[1, 0]] }) }; };
  const baseUrl = 'http://remote.invalid:11434';
  await createOllamaProvider({ baseUrl, model: 'test', dims: 2, fetchImpl }).embed(['private query']);
  assert.equal(calls, 1);
  const ctx = { config: { vault: { path: '.' }, semantic: { baseUrl, dims: 2 } }, env: {}, paths: { stateDir: '/unused' }, fetchImpl };
  await assert.rejects(commands.semanticIndex([], ctx), error => error.code === 'E_SEMANTIC_PROVIDER' && !error.message.includes(baseUrl));
  await assert.rejects(commands.semanticStatus([], ctx), error => error.code === 'E_SEMANTIC_PROVIDER');
  assert.equal(calls, 1);
});

test('core has no static dependency on the optional semantic module', async () => {
  const walk = async dir => (await Promise.all((await fs.readdir(dir, { withFileTypes: true })).map(async entry => entry.isDirectory() ? walk(path.join(dir, entry.name)) : entry.name.endsWith('.mjs') ? [path.join(dir, entry.name)] : []))).flat();
  for (const file of await walk('packages/core/src')) {
    const source = await fs.readFile(file, 'utf8');
    assert.doesNotMatch(source, /(?:import|export)\s+(?:[^;]*?\s+from\s*)?['"][^'"]*modules\/semantic(?:\/[^'"]*)?['"]/u, file);
  }
});

test('provider failures and freshness metrics do not expose query or page content', async t => {
  const dir = await temporary(t), corpusDir = path.join(dir, 'wiki'), stateDir = path.join(dir, 'state');
  await fs.mkdir(corpusDir); await fs.writeFile(path.join(corpusDir, 'page.md'), '# Title\nprivatepagecontent');
  const provider = createOllamaProvider({ model: 'fake', dims: 2, fetchImpl: async () => { throw new Error('privatequery privatepagecontent'); } });
  await assert.rejects(provider.embedQuery('privatequery'), error => !/privatequery|privatepagecontent/.test(String(error.stack)));
  const metrics = await measureIndexFreshness({ corpusDir, index: null });
  assert.doesNotMatch(JSON.stringify(metrics), /privatequery|privatepagecontent/);
  assert.equal(await readSemanticIndex(stateDir), null);
});
