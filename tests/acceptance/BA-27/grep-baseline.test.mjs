// SPDX-License-Identifier: MIT
// BA-27 independent acceptance (grep baseline): hand-computed ranking and metrics on a toy corpus. Written from the brief only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { grepRanking, runGrepBaseline } from '../../../eval/grep-baseline.mjs';

const dirs = [];
process.on('exit', () => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

// Toy corpus. Matching lines per term are counted per line (a line with "kiwi kiwi" counts once).
//   a.md: "kiwi kiwi mango"          -> kiwi 1 line, mango 1 line
//   b.md: "kiwi"                     -> kiwi 1 line
//   c.md: "mango papaya kiwi"        -> kiwi, mango, papaya 1 line each
//   d.md: "papaya"                   -> papaya 1 line
//   e.md: "kiwi" x3 on three lines   -> kiwi 3 lines
const FILES = {
  'a.md': '# A\nkiwi kiwi mango\n',
  'b.md': '# B\nkiwi\n',
  'c.md': '# C\nmango papaya kiwi\n',
  'd.md': '# D\npapaya\n',
  'e.md': '# E\nkiwi\nkiwi\nkiwi\n',
  'g.md': '# G\nışık kaynağı\n',
  'sub/h.md': '# H\nzebra\n',
};

function corpus() {
  const dir = mkdtempSync(join(tmpdir(), 'ba27-grepacc-'));
  dirs.push(dir);
  for (const [rel, text] of Object.entries(FILES)) {
    mkdirSync(join(dir, rel.includes('/') ? rel.split('/')[0] : '.'), { recursive: true });
    writeFileSync(join(dir, rel), text, 'utf8');
  }
  return dir;
}

test('BA-27 grep: ranking is distinct terms, then matching-line total, then path (hand order c, a, e, b, d)', () => {
  const dir = corpus();
  // kiwi+mango+papaya: c (3 terms, 3 lines), a (2 terms, 2 lines), e (1 term, 3 lines), b (1, 1), d (1, 1 -> path after b)
  assert.deepEqual(grepRanking(dir, 'kiwi mango papaya'), ['c.md', 'a.md', 'e.md', 'b.md', 'd.md']);
  // kiwi only: e has 3 lines; a, b, c tie at 1 line and sort by path
  assert.deepEqual(grepRanking(dir, 'kiwi'), ['e.md', 'a.md', 'b.md', 'c.md']);
  assert.deepEqual(grepRanking(dir, 'papaya'), ['c.md', 'd.md']);
  assert.deepEqual(grepRanking(dir, 'xylophone'), []);
});

test('BA-27 grep: query folding follows the Turkish rule (IŞIK matches ışık) and nested paths are returned relative to the corpus', () => {
  const dir = corpus();
  assert.deepEqual(grepRanking(dir, 'IŞIK'), ['g.md']);
  assert.deepEqual(grepRanking(dir, 'zebra'), ['sub/h.md']);
});

test('BA-27 grep: recallAt5, mrrAt10, currentFirstRate on seven cases (hand values in comments)', () => {
  const dir = corpus();
  const casesFile = join(dir, 'cases.json');
  writeFileSync(
    casesFile,
    JSON.stringify([
      { id: 'g1', query: 'kiwi', relevant: ['b.md'] }, // ranking e,a,b,c -> b at 3: recall 1, rr 1/3
      { id: 'g2', query: 'papaya', relevant: ['d.md'] }, // c,d -> d at 2: recall 1, rr 1/2
      { id: 'g3', query: 'kiwi mango papaya', relevant: ['d.md'] }, // d at 5: recall 1 (top 5), rr 1/5
      { id: 'g4', query: 'xylophone', relevant: ['a.md'] }, // no match: recall 0, rr 0
      { id: 'g5', query: 'xylophone', relevant: [], abstain: true }, // not answerable: excluded
      { id: 'g6', query: 'kiwi', relevant: ['e.md'], category: 'current-state' }, // e at 1: recall 1, rr 1, current hit
      { id: 'g7', query: 'papaya', relevant: ['d.md'], category: 'current-state' }, // c first: recall 1, rr 1/2, current miss
    ]),
    'utf8'
  );
  const r = runGrepBaseline({ corpusDir: dir, casesFile });
  assert.equal(r.n, 7, 'n counts every case including abstaining ones');
  // answerable = g1..g4, g6, g7 (6 cases); recall = (1+1+1+0+1+1)/6 = 5/6
  assert.ok(Math.abs(r.recallAt5 - 5 / 6) < 1e-12, `recallAt5 ${r.recallAt5}`);
  // mrr = (1/3 + 1/2 + 1/5 + 0 + 1 + 1/2) / 6 = (38/15) / 6 = 19/45
  assert.ok(Math.abs(r.mrrAt10 - 19 / 45) < 1e-12, `mrrAt10 ${r.mrrAt10}`);
  assert.equal(r.currentCases, 2);
  assert.ok(Math.abs(r.currentFirstRate - 1 / 2) < 1e-12, `currentFirstRate ${r.currentFirstRate}`);
});

test('BA-27 grep: the baseline has no abstain output of its own (abstaining cases are skipped, not scored)', () => {
  const dir = corpus();
  const casesFile = join(dir, 'cases.json');
  writeFileSync(casesFile, JSON.stringify([{ id: 'x', query: 'xylophone', relevant: [], abstain: true }]), 'utf8');
  const r = runGrepBaseline({ corpusDir: dir, casesFile });
  assert.equal(r.n, 1);
  assert.equal(r.recallAt5, 0);
  assert.equal(r.mrrAt10, 0);
  assert.equal(r.currentFirstRate, null);
  assert.equal(r.currentCases, 0);
});
