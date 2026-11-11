// SPDX-License-Identifier: MIT
// BA-09 blind acceptance: multipliers (verified x1.5, weak x0.9, neutral x1), abstention before weighting, and parity with
// main 111732b for neutral pages and for corpora without provenance. Contract: docs/contracts/retrieval.md, "Provenance trust".
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadCandidate, loadMain, makeVault, removeDir, page, record, NOW, repoRoot } from './helpers.mjs';

const rt = await loadCandidate();
let main;
before(async () => { main = await loadMain(); });
after(() => main?.dispose());

const QUERY = 'zephyr quorum ledger';
const BODY = 'zephyr quorum ledger reconciliation notes for the north archive.';
const VERIFIED = `status: confirmed\n${record({})}`;
const WEAK = 'status: proposed\n';
const search = (lib, dir, query = QUERY, options = {}) => lib.search(lib.buildIndex(lib.loadPages(dir), { now: NOW }), query, { limit: 20, abstainThreshold: 0, asOf: NOW, ...options });
const scoreOf = (result, file) => result.results.find((r) => r.path === file)?.score;

test('verified scores are 1.5 times and weak scores 0.9 times the neutral score of the same text', () => {
  const dir = makeVault({ 'n.md': page({ body: BODY }), 'v.md': page({ fm: VERIFIED, body: BODY }), 'w.md': page({ fm: WEAK, body: BODY }) }, 'ba09-mult-');
  try {
    const out = search(rt, dir);
    const n = scoreOf(out, 'n.md');
    assert.ok(n > 0 && n < 1, 'neutral lexical score is in (0, 1)');
    assert.ok(Math.abs(scoreOf(out, 'v.md') - 1.5 * n) < 1e-12, 'verified = 1.5 x neutral');
    assert.ok(Math.abs(scoreOf(out, 'w.md') - 0.9 * n) < 1e-12, 'weak = 0.9 x neutral');
  } finally {
    removeDir(dir);
  }
});

test('ranking puts verified first, neutral next and weak last when the text is identical', () => {
  const dir = makeVault({ 'n.md': page({ body: BODY }), 'v.md': page({ fm: VERIFIED, body: BODY }), 'w.md': page({ fm: WEAK, body: BODY }) }, 'ba09-order-');
  try {
    assert.deepEqual(search(rt, dir).results.map((r) => r.path), ['v.md', 'n.md', 'w.md']);
  } finally {
    removeDir(dir);
  }
});

test('the weight is applied after the lexical score, so the same text gives the same lexical score as main', () => {
  const dir = makeVault({ 'n.md': page({ body: BODY }), 'v.md': page({ fm: VERIFIED, body: BODY }), 'w.md': page({ fm: WEAK, body: BODY }) }, 'ba09-lex-');
  try {
    const mainOut = search(main.retrieval, dir);
    const n = scoreOf(mainOut, 'n.md');
    assert.equal(scoreOf(mainOut, 'v.md'), n, 'main has no weighting, so verified and neutral share the lexical score');
    assert.equal(scoreOf(mainOut, 'w.md'), n);
  } finally {
    removeDir(dir);
  }
});

test('abstention uses the pre-weight best score: a weak page answers at the neutral threshold, a verified page cannot answer above it', () => {
  const neutralDir = makeVault({ 'n.md': page({ body: BODY }) }, 'ba09-abs-n-');
  const weakDir = makeVault({ 'w.md': page({ fm: WEAK, body: BODY }) }, 'ba09-abs-w-');
  const verifiedDir = makeVault({ 'v.md': page({ fm: VERIFIED, body: BODY }) }, 'ba09-abs-v-');
  try {
    const s = search(rt, neutralDir).results[0].score;
    // Threshold equal to the lexical score: the boundary is inclusive (best < threshold abstains), so all three answer.
    for (const dir of [neutralDir, weakDir, verifiedDir]) {
      const out = search(rt, dir, QUERY, { abstainThreshold: s });
      assert.equal(out.abstained, false, `answered at the lexical threshold in ${path.basename(dir)}`);
    }
    // A weak page scores 0.9s but still answers when the threshold is 0.95s, because the decision uses s.
    const weakAt = search(rt, weakDir, QUERY, { abstainThreshold: 0.95 * s });
    assert.equal(weakAt.abstained, false, 'weak page answers at 0.95s');
    assert.ok(weakAt.results[0].score < 0.95 * s, 'and its returned score is below that threshold');
    // A verified page with a score of 1.5s must still abstain when the lexical score is below the threshold.
    const verifiedAbove = search(rt, verifiedDir, QUERY, { abstainThreshold: s + 1e-9 });
    assert.equal(verifiedAbove.abstained, true);
    assert.equal(verifiedAbove.reason, 'below_threshold');
    assert.deepEqual(verifiedAbove.results, []);
  } finally {
    removeDir(neutralDir); removeDir(weakDir); removeDir(verifiedDir);
  }
});

test('a neutral page in a mixed corpus keeps main score exactly, and no trust key appears on it', () => {
  const dir = makeVault({
    'n.md': page({ body: BODY }),
    'v.md': page({ fm: VERIFIED, body: `${BODY} extra words` }),
    'w.md': page({ fm: WEAK, body: `${BODY} other words` }),
  }, 'ba09-mixed-');
  try {
    const cand = search(rt, dir), mainOut = search(main.retrieval, dir);
    const mainScores = new Map(mainOut.results.map((r) => [r.path, r.score]));
    const neutral = cand.results.filter((r) => !Object.hasOwn(r, 'trust'));
    assert.deepEqual(neutral.map((r) => r.path), ['n.md']);
    for (const r of neutral) assert.equal(r.score, mainScores.get(r.path), `${r.path} score equals main`);
    assert.equal(cand.results.find((r) => r.path === 'v.md').trust, 'verified');
    assert.equal(cand.results.find((r) => r.path === 'w.md').trust, 'weak');
  } finally {
    removeDir(dir);
  }
});

// Queries from the development and holdout case files of this repository (read-only); each file is a JSON list of objects
// with a string `query`. Corpora without any provenance must answer exactly like main, including every result field.
const CORPORA = [
  { corpus: 'eval/corpus', cases: ['eval/dev/cases.json'] },
  { corpus: 'eval/corpus-ba', cases: ['eval/dev/identifier-cases.json', 'eval/dev/current-state-cases.json', 'eval/dev/multihop-cases.json', 'eval/dev/near-negative-cases.json'] },
  { corpus: 'eval/corpus-graph', cases: ['eval/dev/multihop-hard-cases.json'] },
];
function queriesFrom(file) {
  const full = path.join(repoRoot, file);
  if (!fs.existsSync(full)) return [];
  const data = JSON.parse(fs.readFileSync(full, 'utf8'));
  return (Array.isArray(data) ? data : data.cases ?? []).map((c) => c.query).filter((q) => typeof q === 'string');
}
test('corpora without provenance answer exactly like main: path, score, snippet and every other field', () => {
  let compared = 0;
  for (const { corpus, cases } of CORPORA) {
    const dir = path.join(repoRoot, corpus);
    if (!fs.existsSync(dir)) continue;
    const indexCand = rt.buildIndex(rt.loadPages(dir), { now: NOW });
    const indexMain = main.retrieval.buildIndex(main.retrieval.loadPages(dir), { now: NOW });
    assert.ok(indexCand.docs.every((d) => d.trust === 'neutral'), `${corpus} has no provenance`);
    for (const file of cases) for (const query of queriesFrom(file)) {
      const opts = { limit: 10, abstainThreshold: 0.35, asOf: NOW };
      const a = rt.search(indexCand, query, opts), b = main.retrieval.search(indexMain, query, opts);
      assert.deepEqual(a, b, `${corpus} / ${file} / ${query}`);
      compared++;
    }
  }
  assert.ok(compared >= 20, `compared ${compared} queries`);
});
