// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runEval } from '../../eval/run-eval.mjs';
import { bm25Fair } from '../../eval/lib/bm25-fair.mjs';

const NOW = new Date('2026-11-10T00:00:00Z');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ba27-fair-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const corpus = path.join(dir, 'corpus');
  fs.mkdirSync(corpus);
  fs.writeFileSync(path.join(corpus, 'alpha.md'), '# Alpha\nzebra quartz ember text\n');
  fs.writeFileSync(path.join(corpus, 'beta.md'), '# Beta\nmarble lantern orbit text\n');
  const casesFile = path.join(dir, 'cases.json');
  fs.writeFileSync(
    casesFile,
    JSON.stringify([
      { id: 'a1', query: 'zebra quartz', relevant: ['alpha.md'] },
      { id: 'a2', query: 'marble', relevant: ['beta.md', 'alpha.md'] },
      { id: 'u1', query: 'unknownterm', relevant: [], abstain: true },
      { id: 'u2', query: 'zebra', relevant: [], abstain: true },
    ])
  );
  return { corpus, casesFile };
}

test('bm25Fair equals runEval on recall, MRR and abstainAccuracy at the default and zero thresholds', (t) => {
  const f = fixture(t);
  for (const abstainThreshold of [0.35, 0]) {
    const legacy = runEval({
      corpusDir: f.corpus,
      casesFile: f.casesFile,
      now: NOW,
      repeat: 1,
      abstainThreshold,
      extended: true,
    });
    const fair = bm25Fair({ corpusDir: f.corpus, casesFile: f.casesFile, now: NOW, abstainThreshold });
    assert.equal(fair.recallAt5, legacy.recallAt5, `recall at ${abstainThreshold}`);
    assert.equal(fair.answerableRecallAt5, legacy.recallAt5);
    assert.equal(fair.mrrAt10, legacy.mrrAt10, `mrr at ${abstainThreshold}`);
    assert.equal(fair.abstainAccuracy, legacy.abstainAccuracy, `abstainAccuracy at ${abstainThreshold}`);
  }
});

test('unansweredReturnedRate: at 0.35 an unrelated query abstains; at 0 any matching term returns a page', (t) => {
  const f = fixture(t);
  const strict = bm25Fair({ corpusDir: f.corpus, casesFile: f.casesFile, now: NOW, abstainThreshold: 0.35 });
  const open = bm25Fair({ corpusDir: f.corpus, casesFile: f.casesFile, now: NOW, abstainThreshold: 0 });
  assert.equal(strict.abstainN, 2);
  assert.equal(open.abstainN, 2);
  // "unknownterm" matches nothing (both abstain); "zebra" matches alpha: returned at 0, and at 0.35 only if it scores above the threshold.
  assert.equal(open.unansweredReturnedRate, 0.5);
  assert.equal(strict.abstainAccuracy, 1 - strict.unansweredReturnedRate);
});

test('a set without unanswerable cases reports abstainN 0 and abstainAccuracy 0 (behaviour kept)', (t) => {
  const f = fixture(t);
  const only = path.join(path.dirname(f.casesFile), 'only.json');
  fs.writeFileSync(only, JSON.stringify([{ id: 'a1', query: 'zebra quartz', relevant: ['alpha.md'] }]));
  const fair = bm25Fair({ corpusDir: f.corpus, casesFile: only, now: NOW, abstainThreshold: 0.35 });
  assert.equal(fair.abstainN, 0);
  assert.equal(fair.abstainAccuracy, 0);
  assert.equal(fair.unansweredReturnedRate, 0);
});
