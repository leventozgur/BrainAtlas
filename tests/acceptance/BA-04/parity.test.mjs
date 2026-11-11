// SPDX-License-Identifier: MIT
// BA-04 independent acceptance: ranking, score and abstain parity with main (commit 22ea9e7) over every eval/dev set.
// The golden fixtures/main-22ea9e7-dev-ranking.json was produced by tools/dump-ranking.mjs run on main. This test runs the
// same dump on the tree under test and compares:
//  - path, score, abstained, reason, truncated: identical for every query at thresholds 0 and 0.35 (sorting/score/abstain);
//  - section fields (heading, anchor, headingPath, snippet digest): identical for every result on an undated page (no date
//    and no Current/Güncel durum heading), since BA-04 must not change those; on a dated page a changed section must be a
//    dated-not-future or current-marked heading of the same page;
//  - no result is a superseded page; a `supersedes` field, when present, is a non-empty sorted list of superseded paths.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadPages } from '../../../packages/core/src/retrieval/index.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
// PM update (2026-11-11): the golden pins main 22ea9e7's ranking. It proves BA-04 changed no ranking, but later tracks
// intentionally change ranking, so these comparisons run only on the BA-04 track branch (same rule as BA-00's main checks).
import { spawnSync as __spawn } from 'node:child_process';
const ONLY_ON_TRACK = { skip: (__spawn('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: here, encoding: 'utf8' }).stdout ?? '').trim() !== 'track/BA-04' };
const golden = JSON.parse(fs.readFileSync(path.join(here, 'fixtures/main-22ea9e7-dev-ranking.json'), 'utf8'));
const SETS = {
  cases: ['eval/corpus', 'eval/dev/cases.json'], natural: ['eval/corpus-natural', 'eval/dev/natural-cases.json'],
  xling: ['eval/corpus-natural', 'eval/dev/xling-cases.json'], identifier: ['eval/corpus-ba', 'eval/dev/identifier-cases.json'],
  currentState: ['eval/corpus-ba', 'eval/dev/current-state-cases.json'], multihop: ['eval/corpus-ba', 'eval/dev/multihop-cases.json'],
  nearNegative: ['eval/corpus-ba', 'eval/dev/near-negative-cases.json'],
};
const DATED = /(?<!\d)\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}Z)?(?!\d)|(?<!\d)\d{2}\.\d{2}\.\d{4}(?!\d)|\bcurrent\b|\bguncel durum\b/iu;
const fold = (s) => s.replace(/[ıİ]/g, 'i').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
const isDatedHeading = (t) => DATED.test(fold(t));

const dump = spawnSync(process.execPath, [path.join(here, 'tools/dump-ranking.mjs'), root], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const candidate = dump.status === 0 ? JSON.parse(dump.stdout) : null;

test('the golden was produced from main commit 22ea9e7 and covers the same case ids and queries as the repository', ONLY_ON_TRACK, () => {
  assert.equal(golden.commit, '22ea9e7963b86b75c3785a14750b1244b6581124');
  for (const [key, [, casesFile]] of Object.entries(SETS)) {
    const cases = JSON.parse(fs.readFileSync(path.join(root, casesFile), 'utf8'));
    assert.deepEqual(golden.sets[key].map(c => c.id), cases.map(c => c.id), key);
    assert.deepEqual(golden.sets[key].map(c => c.query), cases.map(c => c.query), key);
  }
});

test('the dump of the tree under test runs to completion', ONLY_ON_TRACK, () => {
  assert.equal(dump.status, 0, 'dump-ranking.mjs failed');
  assert.ok(candidate && candidate.sets, 'no dump output');
});

test('ranking, score, abstain and reason match main for every query of every dev set (thresholds 0 and 0.35)', ONLY_ON_TRACK, () => {
  let compared = 0;
  for (const key of Object.keys(SETS)) {
    assert.equal(candidate.sets[key].length, golden.sets[key].length, key);
    candidate.sets[key].forEach((cq, i) => {
      const gq = golden.sets[key][i];
      assert.equal(cq.id, gq.id, key);
      for (const t of ['0', '0.35']) {
        const c = cq.runs[t], g = gq.runs[t];
        const where = `${key}/${cq.id}@${t}`;
        assert.equal(c.abstained, g.abstained, `${where} abstained`);
        assert.equal(c.reason, g.reason, `${where} reason`);
        assert.equal(c.truncated, g.truncated, `${where} truncated`);
        assert.deepEqual(c.results.map(r => [r.path, r.score]), g.results.map(r => [r.path, r.score]), `${where} ranking`);
        compared++;
      }
    });
  }
  const queries = Object.keys(SETS).reduce((n, key) => n + golden.sets[key].length, 0);
  assert.equal(compared, 2 * queries);
});

test('section fields match main on undated pages, and only move to dated or current headings on dated pages', ONLY_ON_TRACK, () => {
  const corpusCache = new Map();
  const pagesOf = (corpus) => { if (!corpusCache.has(corpus)) corpusCache.set(corpus, loadPages(path.join(root, corpus))); return corpusCache.get(corpus); };
  let undatedCompared = 0, datedChanged = 0;
  for (const [key, [corpus]] of Object.entries(SETS)) {
    const pages = new Map(pagesOf(corpus).map(p => [p.path, p]));
    candidate.sets[key].forEach((cq, i) => {
      const gq = golden.sets[key][i];
      const c = cq.runs['0'].results, g = gq.runs['0'].results;
      assert.deepEqual(c.map(r => r.path), g.map(r => r.path), `${key}/${cq.id} order`);
      c.forEach((r, j) => {
        const p = pages.get(r.path);
        assert.ok(p, `${key}/${cq.id} result ${r.path} not a walked page`);
        const dated = p.headings.some(isDatedHeading);
        const same = r.heading === g[j].heading && r.anchor === g[j].anchor && r.headingPath === g[j].headingPath && r.snippetSha === g[j].snippetSha;
        if (!dated) {
          assert.ok(same, `${key}/${cq.id} undated page ${r.path} changed its section fields`);
          undatedCompared++;
        } else if (!same) {
          assert.ok(r.heading !== null && isDatedHeading(r.heading), `${key}/${cq.id} ${r.path} moved to a heading without a date or current marker: ${r.heading}`);
          datedChanged++;
        }
      });
    });
  }
  assert.ok(undatedCompared > 0, 'no undated results were compared');
  // Informational only: the number of dated results whose section moved (the expected effect of BA-04).
  console.log(`# info undated results compared=${undatedCompared} dated results with a moved section=${datedChanged}`);
});

test('no result is a superseded page, and any supersedes field is a non-empty sorted list of superseded paths', () => {
  for (const [key, [corpus]] of Object.entries(SETS)) {
    const superseded = new Set(pagesOf2(corpus).filter(p => String(p.frontmatter.status || '').toLowerCase() === 'superseded' || Object.hasOwn(p.frontmatter, 'superseded_by')).map(p => p.path));
    for (const cq of candidate.sets[key]) {
      for (const r of cq.runs['0'].results) {
        assert.ok(!superseded.has(r.path), `${key}/${cq.id} returned superseded ${r.path}`);
        if (r.supersedes !== null && r.supersedes !== undefined) {
          assert.ok(Array.isArray(r.supersedes) && r.supersedes.length > 0, `${key}/${cq.id} empty supersedes`);
          assert.deepEqual(r.supersedes, [...r.supersedes].sort(), `${key}/${cq.id} unsorted supersedes`);
          for (const s of r.supersedes) assert.ok(superseded.has(s), `${key}/${cq.id} supersedes names non-superseded ${s}`);
        }
      }
    }
  }
});

function pagesOf2(corpus) { return loadPages(path.join(root, corpus)); }
