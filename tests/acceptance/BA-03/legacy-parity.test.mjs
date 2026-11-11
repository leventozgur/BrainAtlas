// SPDX-License-Identifier: MIT
// BA-03 independent parity test. The golden file fixtures/legacy-main-dev.json was produced once from the main
// branch (commit c194411, before the identifier change) by running buildIndex/search with limit 10, threshold 0 and
// asOf 2026-11-11 over every eval/dev set. Identifier-free queries must match it exactly. Identifier-bearing queries
// may change; the test then checks that no query that was answered at rank 1 loses that answer.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIndex, loadPages, search } from '../../../packages/core/src/retrieval/index.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const golden = JSON.parse(fs.readFileSync(path.join(here, 'fixtures/legacy-main-dev.json'), 'utf8'));
const now = new Date('2026-11-11T00:00:00Z');

const SETS = [
  { key: 'cases', corpus: 'eval/corpus', cases: 'eval/dev/cases.json', min: 40 },
  { key: 'natural', corpus: 'eval/corpus-natural', cases: 'eval/dev/natural-cases.json', min: 80 },
  { key: 'xling', corpus: 'eval/corpus-natural', cases: 'eval/dev/xling-cases.json', min: 15 },
  { key: 'identifier', corpus: 'eval/corpus-ba', cases: 'eval/dev/identifier-cases.json', min: 0 },
  { key: 'currentState', corpus: 'eval/corpus-ba', cases: 'eval/dev/current-state-cases.json', min: 8 },
  { key: 'multihop', corpus: 'eval/corpus-ba', cases: 'eval/dev/multihop-cases.json', min: 10 },
  { key: 'nearNegative', corpus: 'eval/corpus-ba', cases: 'eval/dev/near-negative-cases.json', min: 8 },
];

// Independent, deliberately broad classifier of queries that might contain an identifier: any token with an
// underscore, slash, dot or digit, a lower-to-upper hump, a leading `--`, or two or more leading capitals.
// Over-selecting only lowers the number of identifier-free queries that are compared, and the minimums below
// guard against that becoming too large.
function mayContainIdentifier(query) {
  return query.split(/\s+/).some(raw => {
    const t = raw.replace(/^[^\p{L}\p{N}-]+|[^\p{L}\p{N}]+$/gu, '');
    return /^--/.test(t) || /_/.test(t) || /[/.]/.test(t) || /\d/.test(t) || /\p{Ll}\p{Lu}/u.test(t) || /^\p{Lu}{2,}/u.test(t);
  });
}

const shape = (r) => ({
  abstained: r.abstained, reason: r.reason,
  // PM update (BA-04, 2026-11-11): BA-04 intentionally changes which section is shown (newest valid dated section);
  // ranking, scores and abstention must still match main exactly, so the section heading is no longer pinned here.
  results: r.results.map(x => ({ path: x.path, score: x.score })),
});

const indexes = new Map();
function indexFor(corpus) {
  if (!indexes.has(corpus)) indexes.set(corpus, buildIndex(loadPages(path.join(root, corpus)), { now }));
  return indexes.get(corpus);
}

test('golden fixture covers every dev set with the same query ids as the repository files', () => {
  for (const set of SETS) {
    const cases = JSON.parse(fs.readFileSync(path.join(root, set.cases), 'utf8'));
    assert.deepEqual(golden[set.key].map(c => c.id), cases.map(c => c.id), set.key);
    assert.deepEqual(golden[set.key].map(c => c.query), cases.map(c => c.query), set.key);
  }
});

test('identifier-free dev queries return results identical to main (path, score, abstain reason)', () => {
  const report = [];
  for (const set of SETS) {
    const cases = JSON.parse(fs.readFileSync(path.join(root, set.cases), 'utf8'));
    const index = indexFor(set.corpus);
    let compared = 0;
    cases.forEach((c, i) => {
      if (mayContainIdentifier(c.query)) return;
      compared++;
      const current = shape(search(index, c.query, { limit: 10, abstainThreshold: 0, asOf: now }));
      const expected = shape(golden[set.key][i]);
      // PM update (BA-08, 2026-11-11): link-graph expansion intentionally adds or lifts linked neighbours below the first result
      // on linked corpora (eval/corpus-ba); there the first result and abstention must still match main. Unlinked corpora keep
      // full parity.
      if (set.corpus === 'eval/corpus-ba') {
        assert.deepEqual({ abstained: current.abstained, reason: current.reason, first: current.results[0] ?? null },
          { abstained: expected.abstained, reason: expected.reason, first: expected.results[0] ?? null }, `${set.key}/${c.id}: ${c.query}`);
      } else assert.deepEqual(current, expected, `${set.key}/${c.id}: ${c.query}`);
    });
    report.push(`${set.key}=${compared}/${cases.length}`);
    assert.ok(compared >= set.min, `${set.key}: expected at least ${set.min} identifier-free queries, got ${compared}`);
  }
  assert.ok(report.length === SETS.length, report.join(' '));
});

test('identifier-bearing dev queries: no query answered at rank 1 on main loses that answer', () => {
  const regressions = [];
  let answered = 0;
  for (const set of SETS) {
    const cases = JSON.parse(fs.readFileSync(path.join(root, set.cases), 'utf8'));
    const index = indexFor(set.corpus);
    cases.forEach((c, i) => {
      const relevant = c.relevant ?? [];
      if (!relevant.length) return;
      const hitOn = (r) => !r.abstained && relevant.includes(r.results[0]?.path);
      const before = shape(golden[set.key][i]);
      const after = search(index, c.query, { limit: 10, abstainThreshold: 0, asOf: now });
      if (hitOn(before)) { answered++; if (!hitOn(after)) regressions.push(`${set.key}/${c.id}`); }
    });
  }
  assert.ok(answered > 0);
  assert.deepEqual(regressions, []);
});

test('natural dev set: recall@5 and abstain accuracy equal main; mean reciprocal rank does not fall', () => {
  const set = SETS.find(s => s.key === 'natural');
  const cases = JSON.parse(fs.readFileSync(path.join(root, set.cases), 'utf8'));
  const index = indexFor(set.corpus);
  const metrics = (results) => {
    let recall5 = 0, mrr = 0, relevantCount = 0, abstainOk = 0, abstainCount = 0;
    cases.forEach((c, i) => {
      const rel = c.relevant ?? [];
      const r = results(i, c);
      if (rel.length) {
        relevantCount++;
        const rank = r.abstained ? -1 : r.results.findIndex(x => rel.includes(x.path));
        if (rank >= 0 && rank < 5) recall5++;
        if (rank >= 0) mrr += 1 / (rank + 1);
      } else {
        abstainCount++;
        if (r.abstained) abstainOk++;
      }
    });
    return { recall5: recall5 / relevantCount, mrr: mrr / relevantCount, abstain: abstainOk / abstainCount };
  };
  const legacy = metrics((i) => golden.natural[i]);
  const current = metrics((i, c) => search(index, c.query, { limit: 10, abstainThreshold: 0, asOf: now }));
  assert.equal(current.recall5, legacy.recall5);
  assert.equal(current.abstain, legacy.abstain);
  assert.ok(current.mrr >= legacy.mrr - 1e-12, `mrr fell: ${legacy.mrr} -> ${current.mrr}`);
});
