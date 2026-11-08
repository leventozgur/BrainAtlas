// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { searchHybrid } from '../../../modules/semantic/src/hybrid.mjs';

const page = (path, body) => ({ path, title: path, body, aliases: [], keywords: [], headings: [], frontmatter: {} });
const provider = { embedQuery: async () => [1, 0] };
test('semantic first survives five unrelated lexical hits when the rankings do not overlap', async () => {
  const pages = [page('target.md', 'other'), ...Array.from({ length: 6 }, (_, i) => page(`noise${i}.md`, 'needle'))];
  const entries = [{ path: 'target.md', vector: [1, 0] }];
  const result = await searchHybrid({ query: 'needle', pages, entries, provider });
  assert.ok(result.some(({ path }) => path === 'target.md'));
  assert.deepEqual(result, await searchHybrid({ query: 'needle', pages, entries, provider, mode: 'rrf', weights: [1, 1] }));
});
test('overlap can push the semantic winner below five in RRF; semantic-primary preserves it', async () => {
  const pages = [page('target.md', 'other'), ...Array.from({ length: 6 }, (_, i) => page(`noise${i}.md`, 'needle'))];
  const entries = [{ path: 'target.md', vector: [1, 0] }, ...pages.slice(1).map(({ path }) => ({ path, vector: [0.9, 0.43589] }))];
  const args = { query: 'needle', pages, entries, provider };
  assert.equal((await searchHybrid(args)).some(({ path }) => path === 'target.md'), false);
  assert.equal((await searchHybrid({ ...args, mode: 'semantic-primary' }))[0].path, 'target.md');
  assert.equal((await searchHybrid({ ...args, weights: [1, 3] }))[0].path, 'noise0.md');
});
test('semantic thresholds accept equality and reject low scores, ties and empty candidates', async () => {
  const pages = [page('a.md', 'needle'), page('b.md', 'needle')];
  const args = { query: 'needle', pages, entries: [{ path: 'a.md', vector: [1, 0] }, { path: 'b.md', vector: [0, 1] }], provider };
  assert.equal((await searchHybrid({ ...args, minSemanticScore: 1, minMargin: 1 })).length, 2);
  const low = await searchHybrid({ ...args, minSemanticScore: 1, provider: { embedQuery: async () => [0, 1] }, entries: [{ path: 'a.md', vector: [1, 0] }] });
  assert.equal(low.abstained, true); assert.equal(low.reason, 'min-semantic-score');
  const tie = await searchHybrid({ ...args, entries: pages.map(({ path }) => ({ path, vector: [1, 0] })), minMargin: 0.01 });
  assert.equal(tie.reason, 'min-margin');
  assert.equal((await searchHybrid({ ...args, entries: [], minMargin: 0 })).reason, 'no-semantic-results');
  assert.equal((await searchHybrid({ ...args, provider: { embedQuery: async () => { throw Error('private'); } } })).fallbackReason, 'provider-error');
});
test('semantic-primary breaks equal scores with lexical rank and retains lexical threshold', async () => {
  const pages = [page('a.md', 'other'), page('b.md', 'needle')];
  const entries = pages.map(({ path }) => ({ path, vector: [1, 0] }));
  const args = { query: 'needle', pages, entries, provider, mode: 'semantic-primary' };
  assert.equal((await searchHybrid(args))[0].path, 'b.md');
  assert.equal((await searchHybrid({ ...args, abstainThreshold: 1 }))[0].path, 'a.md');
  assert.equal((await searchHybrid({ ...args, indexMeta: { providerFingerprint: 'x' } })).fallbackReason, 'fingerprint-mismatch');
});
