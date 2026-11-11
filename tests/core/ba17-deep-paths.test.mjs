// SPDX-License-Identifier: MIT
// BA-17: deep vault paths (more than twelve separator segments) index the suffix chains of their last four path
// components, however many `.`/`-` pieces those components contain. Hermetic: in-memory index, no files, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex, search } from '../../packages/core/src/retrieval/index.mjs';

const now = new Date('2026-11-11T00:00:00Z');
const run = (index, query) => search(index, query, { limit: 10, abstainThreshold: 0, asOf: now });

// `dirs` directory components, then `middle`, then `leaf`; directory names are `d00`, `d01`, ...
function components(dirs, leaf, middle = []) {
  return [...Array.from({ length: dirs }, (_, i) => `d${String(i).padStart(2, '0')}`), ...middle, leaf];
}
function vaultWith(parts) {
  return buildIndex([
    { path: 'deep/target.md', title: 'Target', aliases: [], keywords: [], headings: [], body: `Handler lives at ${parts.join('/')}. Retries are capped.`, frontmatter: {} },
    { path: 'notes/other.md', title: 'Other', aliases: [], keywords: [], headings: [], body: 'Other notes about bread and rivers.', frontmatter: {} },
  ], { now });
}

for (const depth of [13, 14, 20, 40]) {
  test(`a ${depth}-component path with a hyphenated basename: every suffix of 1 to 4 components finds the document`, () => {
    const leaf = `handler-x-${depth}.mjs`;
    const parts = components(depth - 1, leaf);
    const index = vaultWith(parts);
    for (let k = 1; k <= 4; k++) {
      const query = parts.slice(-k).join('/');
      const r = run(index, `Where is ${query}?`);
      assert.notEqual(r.reason, 'identifier-not-found', `${k}-component suffix ${query}`);
      assert.equal(r.results[0]?.path, 'deep/target.md', `${k}-component suffix ${query}`);
    }
  });
}

test('a 14-component path whose second-to-last component contains dots and hyphens: the 2-component suffix is indexed whole', () => {
  const leaf = 'handler-x-14.mjs';
  const parts = components(12, leaf, ['build-2.1']);
  const index = vaultWith(parts);
  const query = 'build-2.1/handler-x-14.mjs';
  const r = run(index, `Where is ${query}?`);
  assert.notEqual(r.reason, 'identifier-not-found');
  assert.equal(r.results[0]?.path, 'deep/target.md');
});

test('a non-consecutive subpath of a deep hyphenated path is still not a match', () => {
  const leaf = 'handler-x-20.mjs';
  const parts = components(19, leaf);
  const index = vaultWith(parts);
  const gapped = [parts[16], parts[18], leaf].join('/');
  assert.equal(run(index, gapped).reason, 'identifier-not-found', gapped);
});

test('a short hyphenated path (twelve segments or fewer) keeps every suffix chain', () => {
  const leaf = 'handler-x-6.mjs';
  const parts = components(5, leaf);
  const index = vaultWith(parts);
  for (let k = 1; k <= parts.length; k++) {
    const query = parts.slice(-k).join('/');
    const r = run(index, `Where is ${query}?`);
    assert.notEqual(r.reason, 'identifier-not-found', query);
    assert.equal(r.results[0]?.path, 'deep/target.md', query);
  }
});
