// SPDX-License-Identifier: MIT
// BA-27 fix1 re-test (fair comparison fields): hand-computed values on a toy corpus for the BM25 side
// (bm25Fair at threshold 0.35 and 0) and the grep side (runGrepBaseline). Written from the brief only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildIndex, loadPages, search } from '../../../packages/core/src/retrieval/index.mjs';
import { runEval } from '../../../eval/run-eval.mjs';
import { runGrepBaseline } from '../../../eval/grep-baseline.mjs';
import { bm25Fair } from '../../../eval/lib/bm25-fair.mjs';

const dirs = [];
process.on('exit', () => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const NOW = new Date('2026-11-10T00:00:00Z');
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-12, `${msg}: expected ${b}, got ${a}`);

const PAGES = {
  'alpha.md': '---\ntitle: Zyqorvex gateway\nstatus: active\ngenerated: "2026-06-01"\n---\n# Zyqorvex gateway\n\n## Overview\nThe zyqorvex gateway accepts requests.\n\n## Timeouts\nThe zyqorvex gateway applies a timeout of thirty seconds.\n',
  'sub/beta.md': '---\ntitle: Quillfrost ledger\nstatus: active\ngenerated: "2026-06-01"\n---\n# Quillfrost ledger\n\nThe quillfrost ledger stores double entry records.\n',
  'index.md': '---\ntitle: Index\nstatus: active\ngenerated: "2026-06-01"\n---\n# Index\n\nzyqorvex pointer page.\n',
};

// Answerable: A1 (alpha, hit at both thresholds), A2 (beta, hit), A3 (wrong label, miss), A4 (alpha, hit only at 0:
// at 0.35 the query abstains because its top score is below the threshold).
// Unanswerable: U1 (no term matches), U2 (term matches alpha; returned at both thresholds),
// U3 ("devam et", no term matches), U4 (same query as A4; returned only at 0).
const CASES = [
  { id: 'A1', query: 'zyqorvex timeout', relevant: ['alpha.md'] },
  { id: 'A2', query: 'quillfrost ledger', relevant: ['sub/beta.md'] },
  { id: 'A3', query: 'quillfrost ledger', relevant: ['alpha.md'] },
  { id: 'A4', query: 'zyqorvex unknownterm xqzzy', relevant: ['alpha.md'] },
  { id: 'U1', query: 'unknownterm xqzzy', relevant: [], abstain: true },
  { id: 'U2', query: 'zyqorvex', relevant: [], abstain: true },
  { id: 'U3', query: 'devam et', relevant: [], abstain: true },
  { id: 'U4', query: 'zyqorvex unknownterm xqzzy', relevant: [], abstain: true },
];

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ba27-fair-'));
  dirs.push(dir);
  for (const [rel, text] of Object.entries(PAGES)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text, 'utf8');
  }
  const casesFile = join(dir, 'cases.json');
  writeFileSync(casesFile, JSON.stringify(CASES), 'utf8');
  return { dir, casesFile };
}

test('BA-27 fix1 toy: search membership matches the design (preconditions for the hand arithmetic)', () => {
  const { dir } = fixture();
  const index = buildIndex(loadPages(dir), { now: NOW });
  const at = (q, t) => search(index, q, { limit: 10, asOf: NOW, abstainThreshold: t });
  assert.equal(at('zyqorvex unknownterm xqzzy', 0.35).abstained, true);
  assert.deepEqual(at('zyqorvex unknownterm xqzzy', 0).results.map((r) => r.path), ['alpha.md', 'index.md']);
  assert.deepEqual(at('zyqorvex', 0.35).results.map((r) => r.path), ['alpha.md', 'index.md']);
  assert.equal(at('unknownterm xqzzy', 0.35).results.length, 0);
  assert.equal(at('devam et', 0).results.length, 0);
  assert.deepEqual(at('quillfrost ledger', 0.35).results.map((r) => r.path), ['sub/beta.md']);
});

test('BA-27 fix1 toy: bm25Fair at threshold 0.35 equals the hand values', () => {
  const { dir, casesFile } = fixture();
  const r = bm25Fair({ corpusDir: dir, casesFile, now: NOW, abstainThreshold: 0.35 });
  // answerable A1..A4: recall 1, 1, 0, 0 (A4 abstains) -> 0.5; rr 1, 1, 0, 0 -> 0.5
  // unanswerable U1..U4: abstained U1, U3, U4 -> 3/4; returned U2 -> 1/4
  close(r.recallAt5, 0.5, 'recallAt5');
  close(r.answerableRecallAt5, 0.5, 'answerableRecallAt5');
  close(r.mrrAt10, 0.5, 'mrrAt10');
  close(r.abstainAccuracy, 3 / 4, 'abstainAccuracy');
  close(r.unansweredReturnedRate, 1 / 4, 'unansweredReturnedRate');
  assert.equal(r.abstainN, 4);
});

test('BA-27 fix1 toy: bm25Fair at threshold 0 (no abstention) equals the hand values', () => {
  const { dir, casesFile } = fixture();
  const r = bm25Fair({ corpusDir: dir, casesFile, now: NOW, abstainThreshold: 0 });
  // A4 now answered (alpha first): recall 1, 1, 0, 1 -> 0.75; rr 1, 1, 0, 1 -> 0.75
  // U1, U3 abstain -> 2/4; U2, U4 returned -> 2/4
  close(r.recallAt5, 0.75, 'recallAt5');
  close(r.answerableRecallAt5, 0.75, 'answerableRecallAt5');
  close(r.mrrAt10, 0.75, 'mrrAt10');
  close(r.abstainAccuracy, 0.5, 'abstainAccuracy');
  close(r.unansweredReturnedRate, 0.5, 'unansweredReturnedRate');
  assert.equal(r.abstainN, 4);
});

test('BA-27 fix1 toy: bm25Fair agrees with the existing runEval on the comparable fields, at both thresholds', () => {
  const { dir, casesFile } = fixture();
  for (const t of [0.35, 0]) {
    const fair = bm25Fair({ corpusDir: dir, casesFile, now: NOW, abstainThreshold: t });
    const old = runEval({ corpusDir: dir, casesFile, now: NOW, repeat: 1, abstainThreshold: t });
    close(fair.recallAt5, old.recallAt5, `recallAt5 at ${t}`);
    close(fair.mrrAt10, old.mrrAt10, `mrrAt10 at ${t}`);
    close(fair.abstainAccuracy, old.abstainAccuracy, `abstainAccuracy at ${t}`);
  }
});

test('BA-27 fix1 toy: grep side is hand-computed (answerable recall, abstain returns, abstainAccuracy = 1 - returned rate)', () => {
  const { dir, casesFile } = fixture();
  const g = runGrepBaseline({ corpusDir: dir, casesFile });
  // grep answerable: A1 alpha rank 1, A2 beta rank 1, A3 alpha absent (ranking [beta]), A4 alpha rank 1 -> recall 3/4, rr 3/4
  close(g.recallAt5, 3 / 4, 'recallAt5');
  close(g.answerableRecallAt5, 3 / 4, 'answerableRecallAt5 equals recallAt5');
  close(g.mrrAt10, 3 / 4, 'mrrAt10');
  // grep returns for U2 ('zyqorvex') and U4 (contains 'zyqorvex'); U1 and U3 match no line
  assert.equal(g.abstainN, 4);
  close(g.unansweredReturnedRate, 2 / 4, 'unansweredReturnedRate');
  close(g.abstainAccuracy, 1 - 2 / 4, 'abstainAccuracy');
});

test('BA-27 fix1 toy: a set without unanswerable cases reports abstainN 0 and 0 rates on both sides', () => {
  const dir = fixture().dir;
  const casesFile = join(dir, 'answerable-only.json');
  writeFileSync(casesFile, JSON.stringify(CASES.filter((c) => !c.abstain)), 'utf8');
  const fair = bm25Fair({ corpusDir: dir, casesFile, now: NOW, abstainThreshold: 0.35 });
  const g = runGrepBaseline({ corpusDir: dir, casesFile });
  assert.equal(fair.abstainN, 0);
  assert.equal(fair.abstainAccuracy, 0);
  assert.equal(fair.unansweredReturnedRate, 0);
  assert.equal(g.abstainN, 0);
  assert.equal(g.abstainAccuracy, 0);
  assert.equal(g.unansweredReturnedRate, 0);
});
