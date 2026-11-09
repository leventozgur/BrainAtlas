// SPDX-License-Identifier: MIT
// Acceptance (2): adaptive group size, driven by an injected clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { updateSemanticIndex, markdownChunks, createOllamaProvider } from '../../../modules/semantic/src/index.mjs';
import { exists, fakeClock, fakeProvider, sectionPage, workspace } from './helpers.mjs';
import { join } from 'node:path';

async function run(t, { chunks = 200, durations, indexBatchSize = 32, provider } = {}) {
  const w = await workspace(t, { 'page.md': sectionPage('Page', chunks) });
  const clock = fakeClock();
  const p = provider ?? fakeProvider({ clock, durations });
  const index = await updateSemanticIndex({ corpusDir: w.wiki, stateDir: w.stateDir, provider: p, chunkMarkdown: markdownChunks, indexBatchSize, now: p.clock.now });
  return { w, p, index };
}

test('25 s group halves the next group, 3 s group doubles it, capped by indexBatchSize, floored at 1', async t => {
  const { p, index } = await run(t, { chunks: 200, durations: [25000, 25000, 10000, 3000, 3000, 3000, 3000] });
  assert.deepEqual(p.sizes.slice(0, 7), [32, 16, 8, 8, 16, 32, 32]);
  assert.equal(p.sizes.reduce((a, b) => a + b, 0), 200);
  assert.equal(index.entries.length, 200);
  assert.ok(p.sizes.every(size => size >= 1 && size <= 32));
});

test('slow groups never drive the size below 1', async t => {
  const { p } = await run(t, { chunks: 20, indexBatchSize: 4, durations: [30000] });
  assert.deepEqual(p.sizes.slice(0, 6), [4, 2, 1, 1, 1, 1]);
  assert.ok(p.sizes.every(size => size >= 1));
  assert.equal(p.sizes.reduce((a, b) => a + b, 0), 20);
});

test('fast groups never exceed indexBatchSize', async t => {
  for (const size of [1, 2, 5, 8, 16, 32]) {
    const { p } = await run(t, { chunks: 100, indexBatchSize: size, durations: [10] });
    assert.ok(p.sizes.every(item => item <= size), `size ${size}: ${p.sizes}`);
    assert.equal(p.sizes[0], size, `initial group is min(indexBatchSize, 32) for ${size}`);
  }
});

test('indexBatchSize 64 starts at 32 and grows to 64 only after a fast group', async t => {
  const fast = await run(t, { chunks: 200, indexBatchSize: 64, durations: [100] });
  assert.deepEqual(fast.p.sizes.slice(0, 3), [32, 64, 64]);
  const slow = await run(t, { chunks: 200, indexBatchSize: 64, durations: [30000] });
  assert.deepEqual(slow.p.sizes.slice(0, 3), [32, 16, 8]);
});

test('threshold boundaries: exactly 20 s and exactly 5 s keep the size, 20.001 s halves, 4.999 s doubles', async t => {
  const cases = [[20000, 32], [20001, 16], [5000, 32], [4999, 32], [5001, 32], [19999, 32]];
  for (const [duration, expectedAtFull] of cases) {
    const { p } = await run(t, { chunks: 80, indexBatchSize: 32, durations: [duration] });
    assert.equal(p.sizes[1], expectedAtFull, `after ${duration} ms`);
  }
  // 4.999 s doubles from a reduced size, so start reduced first.
  const { p } = await run(t, { chunks: 400, indexBatchSize: 32, durations: [30000, 4999, 5000, 5001] });
  assert.deepEqual(p.sizes.slice(0, 5), [32, 16, 32, 32, 32]);
  const mid = await run(t, { chunks: 120, indexBatchSize: 32, durations: [30000, 5000, 5000] });
  assert.deepEqual(mid.p.sizes.slice(0, 3), [32, 16, 16], 'exactly 5 s keeps the size');
  const edge = await run(t, { chunks: 120, indexBatchSize: 32, durations: [30000, 20000, 20000] });
  assert.deepEqual(edge.p.sizes.slice(0, 3), [32, 16, 16], 'exactly 20 s keeps the size');
});

test('invalid indexBatchSize values are rejected before any provider call or state write', async t => {
  for (const bad of [0, 65, -1, 1.5, '8', NaN, null]) {
    const w = await workspace(t, { 'page.md': sectionPage('Page', 3) });
    const provider = fakeProvider({});
    await assert.rejects(updateSemanticIndex({ corpusDir: w.wiki, stateDir: w.stateDir, provider, chunkMarkdown: markdownChunks, indexBatchSize: bad }), undefined, String(bad));
    assert.equal(provider.calls.length, 0);
    assert.equal(await exists(join(w.semanticDir, 'index.json')), false);
  }
});

test('boundary indexBatchSize values 1 and 64 are accepted', async t => {
  for (const size of [1, 64]) {
    const { index } = await run(t, { chunks: 5, indexBatchSize: size, durations: [1] });
    assert.equal(index.entries.length, 5);
  }
});

test('groups reach the real Ollama provider unsplit: each request carries exactly one indexer group', async t => {
  const w = await workspace(t, { 'page.md': sectionPage('Page', 200) });
  const clock = fakeClock();
  const inputs = [];
  const fetchImpl = async (_url, request) => {
    const body = JSON.parse(request.body); inputs.push(body.input.length); clock.advance(100);
    return { ok: true, json: async () => ({ embeddings: body.input.map(() => [1, 0]) }) };
  };
  const provider = createOllamaProvider({ model: 'm', dims: 2, fetchImpl, batchSize: 64, timeoutMs: 120000 });
  await updateSemanticIndex({ corpusDir: w.wiki, stateDir: w.stateDir, provider, chunkMarkdown: markdownChunks, indexBatchSize: 64, now: clock.now });
  assert.deepEqual(inputs, [32, 64, 64, 40], 'fast provider: 32 then doubled to 64, no internal re-splitting at 32');
});

test('a provider exposing only embed() is still driven group by group', async t => {
  const w = await workspace(t, { 'page.md': sectionPage('Page', 70) });
  const sizes = [];
  const provider = { id: 'only-embed', dims: 2, fingerprint: 'fp', async embed(texts) { sizes.push(texts.length); return texts.map(() => [1, 0]); } };
  const index = await updateSemanticIndex({ corpusDir: w.wiki, stateDir: w.stateDir, provider, chunkMarkdown: markdownChunks });
  assert.equal(index.entries.length, 70);
  assert.ok(sizes.every(size => size <= 32));
});

test('invalid vectors from the provider fail closed and write no index', async t => {
  const w = await workspace(t, { 'page.md': sectionPage('Page', 4) });
  for (const vectors of [texts => texts.map(() => [1]), texts => texts.slice(1).map(() => [1, 0, 0]), texts => texts.map(() => [Number.NaN, 0, 0])]) {
    const provider = fakeProvider({ vector: undefined });
    provider.embedDocuments = async texts => vectors(texts);
    await assert.rejects(updateSemanticIndex({ corpusDir: w.wiki, stateDir: w.stateDir, provider, chunkMarkdown: markdownChunks }), /invalid vectors/iu);
    assert.equal(await exists(join(w.semanticDir, 'index.json')), false);
    assert.equal(await exists(join(w.semanticDir, 'index.lock')), false);
  }
});
