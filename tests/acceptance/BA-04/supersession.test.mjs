// SPDX-License-Identifier: MIT
// BA-04 independent acceptance: `supersedes` routing. Superseded pages never appear in results, a replacement lists every
// superseded page that resolves to it (sorted), chains resolve to their final indexed page, loops and dangling targets route
// nothing, and ranking, score and abstention are unaffected. Hermetic: in-memory pages, fixed as-of date.
import test from 'node:test';
import assert from 'node:assert/strict';
import { page, run, indexOf, NOW } from './helpers.mjs';
import { search } from '../../../packages/core/src/retrieval/index.mjs';

const old = (relPath, next, body = 'legacy quota is 10 per day') => page(relPath, `# Quota\n${body}\n`, { status: 'superseded', superseded_by: next });
const current = (relPath, body = 'quota is 50 per day') => page(relPath, `# Quota\n${body}\n`, { status: 'confirmed' });
const paths = (r) => r.results.map(x => x.path);

test('a superseded page never appears in results, even for an exact query on its own text', () => {
  const pages = [old('a.md', 'b.md'), current('b.md')];
  const r = run(pages, 'legacy quota');
  assert.ok(!paths(r).includes('a.md'));
});

test('the replacement carries supersedes with the superseded page, and ranking is unchanged', () => {
  const pages = [old('a.md', 'b.md'), current('b.md')];
  const r = run(pages, 'quota per day');
  const b = r.results.find(x => x.path === 'b.md');
  assert.deepEqual(b.supersedes, ['a.md']);
  // Compared with the same vault minus the superseded page: identical paths, scores, abstain state.
  const without = run([current('b.md')], 'quota per day');
  assert.deepEqual(r.results.map(({ path, score }) => ({ path, score })), without.results.map(({ path, score }) => ({ path, score })));
  assert.equal(r.abstained, without.abstained);
});

test('a superseded page does not add its text to the replacement (no ranking leak)', () => {
  const pages = [old('a.md', 'b.md', 'zebra zebra zebra quota'), current('b.md')];
  const r = run(pages, 'zebra');
  assert.equal(r.abstained, true);
  assert.deepEqual(r.results, []);
});

test('a chain A -> B -> C routes both A and B to C, and neither is in the results', () => {
  const pages = [old('a.md', 'b.md'), old('b.md', 'c.md', 'interim quota is 20 per day'), current('c.md')];
  const r = run(pages, 'quota per day');
  assert.deepEqual(paths(r), ['c.md']);
  assert.deepEqual(r.results[0].supersedes, ['a.md', 'b.md']);
});

test('a two-page loop routes nothing and neither page is indexed', () => {
  const pages = [old('a.md', 'b.md'), old('b.md', 'a.md'), current('c.md')];
  const r = run(pages, 'legacy quota');
  assert.ok(!paths(r).includes('a.md') && !paths(r).includes('b.md'));
  for (const x of run(pages, 'quota per day').results) assert.equal(x.supersedes, undefined);
});

test('a chain that enters a loop routes nothing, while the loop-free page stays normal', () => {
  const pages = [old('a.md', 'b.md'), old('b.md', 'c.md'), old('c.md', 'b.md'), current('d.md')];
  const r = run(pages, 'quota per day');
  assert.deepEqual(paths(r), ['d.md']);
  assert.equal(r.results[0].supersedes, undefined);
});

test('a self-referencing superseded page routes nothing', () => {
  const pages = [old('a.md', 'a.md'), current('b.md')];
  const r = run(pages, 'quota per day');
  assert.deepEqual(paths(r), ['b.md']);
  assert.equal(r.results[0].supersedes, undefined);
});

test('a superseded_by that names a page not in the vault routes nothing', () => {
  const pages = [old('a.md', 'missing.md'), current('b.md')];
  const r = run(pages, 'quota per day');
  assert.deepEqual(paths(r), ['b.md']);
  assert.equal(r.results[0].supersedes, undefined);
});

test('a superseded_by that ends at a superseded page with no successor routes nothing', () => {
  const pages = [old('a.md', 'z.md'), old('z.md', null), current('b.md')];
  const r = run(pages, 'quota per day');
  assert.deepEqual(paths(r), ['b.md']);
  assert.equal(r.results[0].supersedes, undefined);
});

test('several superseded pages to one target are listed sorted, whatever the input order', () => {
  const forward = [old('a-old.md', 'z.md'), old('m-old.md', 'z.md'), old('z-old.md', 'z.md'), current('z.md')];
  const backward = [...forward].reverse();
  assert.deepEqual(run(forward, 'quota per day').results[0].supersedes, ['a-old.md', 'm-old.md', 'z-old.md']);
  assert.deepEqual(run(backward, 'quota per day').results[0].supersedes, ['a-old.md', 'm-old.md', 'z-old.md']);
});

test('a page with status superseded but no superseded_by is not indexed and routes nothing', () => {
  const pages = [page('a.md', '# Quota\nlegacy quota is 10\n', { status: 'superseded' }), current('b.md')];
  const r = run(pages, 'legacy quota');
  assert.ok(!paths(r).includes('a.md'));
  for (const x of run(pages, 'quota per day').results) assert.equal(x.supersedes, undefined);
});

test('a superseded_by key with a null value still makes the page superseded, and it is not indexed', () => {
  const pages = [page('a.md', '# Quota\nlegacy quota is 10\n', { superseded_by: null }), current('b.md')];
  assert.ok(!paths(run(pages, 'legacy quota')).includes('a.md'));
});

test('the supersedes field is absent when no superseded page routes to a result', () => {
  const r = run([current('b.md')], 'quota per day');
  assert.equal(r.results.length, 1);
  assert.equal(Object.hasOwn(r.results[0], 'supersedes'), false);
});

test('the index stores routing as replacement -> sorted sources, and it is not shared with search output', () => {
  const index = indexOf([old('y.md', 'b.md'), old('x.md', 'b.md'), current('b.md')]);
  assert.deepEqual({ ...index.supersedes }, { 'b.md': ['x.md', 'y.md'] });
  const first = search(index, 'quota per day', { limit: 5, asOf: NOW });
  first.results[0].supersedes.push('tampered.md');
  const second = search(index, 'quota per day', { limit: 5, asOf: NOW });
  assert.deepEqual(second.results[0].supersedes, ['x.md', 'y.md']);
});
