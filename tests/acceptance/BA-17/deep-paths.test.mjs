// SPDX-License-Identifier: MIT
// BA-17 deep-path fix, black-box through search(): a document whose body names a vault path of 13, 16, 20 or 40
// components must be found by the last 1-4 path components of that path (basenames with `-`, `.` and `_` included),
// and by the full path. A non-consecutive part of a path still abstains. Deterministic, no timing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRetrieval, page, NOW } from './support.mjs';

const { buildIndex, search } = await loadRetrieval();
const run = (index, query, options = {}) => search(index, query, { limit: 10, abstainThreshold: 0, asOf: NOW, ...options });

// Each variant: the last components of the path (the basename may itself hold `.`, `-` and `_`).
const leaves = [
  ['handler-x-13.mjs'],
  ['build-2.1', 'report.v2.json'],
  ['a_b.c-d.mjs'],
];

function makePaths(depth) {
  return leaves.map((tail) => {
    const dirs = Array.from({ length: depth - tail.length }, (_, i) => `dir${i + 1}`);
    return [...dirs, ...tail].join('/');
  });
}

for (const depth of [13, 16, 20, 40]) {
  const paths = makePaths(depth);
  const pages = paths.map((p, i) => page(`deep/${depth}-${i}.md`, `Reference: ${p} is the file under test.`, { title: `Deep ${depth} ${i}` }));
  pages.push(page('deep/decoy.md', 'Plain prose about gardens, rivers and bread.', { title: 'Decoy' }));
  const index = buildIndex(pages, { now: NOW });

  test(`${depth} components: the full path finds its page first`, () => {
    paths.forEach((p, i) => {
      const r = run(index, p);
      assert.equal(r.abstained, false, `${p}: must not abstain`);
      assert.equal(r.results[0].path, `deep/${depth}-${i}.md`, `${p}: top result`);
    });
  });

  test(`${depth} components: every last 1-4 component suffix finds the page and never gives identifier-not-found`, () => {
    paths.forEach((p, i) => {
      const parts = p.split('/');
      for (let k = 1; k <= 4; k++) {
        const suffix = parts.slice(-k).join('/');
        for (const query of [suffix, `where is ${suffix}?`]) {
          const r = run(index, query);
          assert.notEqual(r.reason, 'identifier-not-found', `${depth} ${query}`);
          assert.equal(r.abstained, false, `${depth} ${query}`);
          assert.ok(r.results.some(x => x.path === `deep/${depth}-${i}.md`), `${depth} "${query}" must return deep/${depth}-${i}.md`);
        }
      }
    });
  });

  test(`${depth} components: a non-consecutive part of the path still abstains with identifier-not-found`, () => {
    paths.forEach((p) => {
      const parts = p.split('/');
      const n = parts.length;
      const gapped = [
        [parts[n - 3], parts[n - 1]].join('/'),
        [parts[n - 4], parts[n - 2], parts[n - 1]].join('/'),
        [parts[n - 5], parts[n - 3], parts[n - 2], parts[n - 1]].join('/'),
      ];
      for (const query of gapped) {
        const r = run(index, query);
        assert.equal(r.abstained, true, `${depth} gapped ${query} must abstain`);
        assert.equal(r.reason, 'identifier-not-found', `${depth} gapped ${query}`);
      }
    });
  });

  test(`${depth} components: a long question with one unknown deep suffix still ranks normally (share of identifier units below 0.2)`, () => {
    const r = run(index, 'Could you explain in detail how the retry flow of the widget pipeline changed, and what dir99/handler-x-13.mjs does today?', { abstainThreshold: 0 });
    assert.notEqual(r.reason, 'identifier-not-found', 'long natural question with unknown identifier must not abstain');
  });
}

test('the three former BA-18 todo cases pass: suffix windows count path components, not dotted or hyphenated pieces', () => {
  // Same shape as the BA-03 final-verification cases: a 13/16/20/40-component path whose basename is dotted and hyphenated.
  for (const depth of [13, 16, 20, 40]) {
    const leaf = `handler-x-${depth}.mjs`;
    const dirs = Array.from({ length: depth - 1 }, (_, i) => `dir${i}`);
    const idx = buildIndex([page('x.md', `Reference: ${[...dirs, leaf].join('/')}`, { title: 'X' })], { now: NOW });
    const deepSuffix = `${dirs[dirs.length - 2]}/${dirs[dirs.length - 1]}/${leaf}`;
    assert.equal(run(idx, `${dirs[dirs.length - 1]}/${leaf}`).reason ?? null, null, `${depth}: 2-component suffix`);
    assert.equal(run(idx, deepSuffix).abstained, false, `${depth}: 3-component suffix`);
    assert.equal(run(idx, leaf).abstained, false, `${depth}: basename`);
  }
});

test('a 12-component path with a hyphenated basename finds its suffixes (the window is not a segment count)', () => {
  // Diagnostic-grade fixture for the boundary: 12 components but more than 12 segments once `.` and `-` are counted.
  const dirs = Array.from({ length: 11 }, (_, i) => `d${i}`);
  const leaf = 'handler-x-13.mjs';
  const idx = buildIndex([page('b.md', `Reference: ${[...dirs, leaf].join('/')}`, { title: 'B' })], { now: NOW });
  assert.equal(run(idx, `d10/${leaf}`).abstained, false, '2-component suffix of 12-component path');
});
