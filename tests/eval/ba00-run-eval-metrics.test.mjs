// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runEval } from '../../eval/run-eval.mjs';

function fixture(t, cases) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ba00-metrics-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const corpusDir = path.join(dir, 'corpus');
  fs.mkdirSync(corpusDir);
  fs.writeFileSync(path.join(corpusDir, 'one.md'), '# One\n## First section\nshared needle alpha detail\n');
  fs.writeFileSync(path.join(corpusDir, 'two.md'), '# Two\n## Second section\nshared needle beta detail\n');
  const casesFile = path.join(dir, 'cases.json');
  fs.writeFileSync(casesFile, JSON.stringify(cases));
  return {corpusDir, casesFile};
}

const NOW = new Date('2026-11-10T00:00:00Z');

test('sectionHitRate counts answerable expectedHeading cases only; hand-calculated 1/3', (t) => {
  const paths = fixture(t, [
    {id: 's1', query: 'shared needle alpha', relevant: ['one.md'], expectedHeading: 'First section'},
    {id: 's2', query: 'shared needle beta', relevant: ['one.md'], expectedHeading: 'Second section'},
    {id: 's4', query: 'alpha', relevant: ['two.md'], expectedHeading: 'Second section'},
    {id: 'abstain-with-heading', query: 'unmatched zzz', relevant: [], abstain: true, expectedHeading: 'First section'},
    {id: 'plain', query: 'shared needle alpha', relevant: ['one.md']},
  ]);
  const result = runEval({...paths, now: NOW, repeat: 1, extended: true});
  assert.equal(result.sectionCases, 3);
  assert.ok(Math.abs(result.sectionHitRate - 1 / 3) < 1e-12);
});

test('requireAllRate requires every relevant path in the top five; hand-calculated 1/2', (t) => {
  const paths = fixture(t, [
    {id: 'r1', query: 'shared needle alpha', relevant: ['one.md', 'two.md'], requireAll: true},
    {id: 'r2', query: 'shared needle alpha', relevant: ['one.md', 'missing.md'], requireAll: true},
    {id: 'plain', query: 'shared needle alpha', relevant: ['one.md', 'two.md']},
  ]);
  const result = runEval({...paths, now: NOW, repeat: 1, extended: true});
  assert.equal(result.requireAllCases, 2);
  assert.equal(result.requireAllRate, 0.5);
});

test('new keys are zero when no case uses expectedHeading or requireAll', (t) => {
  const paths = fixture(t, [{id: 'plain', query: 'shared needle alpha', relevant: ['one.md']}]);
  const result = runEval({...paths, now: NOW, repeat: 1, extended: true});
  assert.equal(result.sectionHitRate, 0);
  assert.equal(result.sectionCases, 0);
  assert.equal(result.requireAllRate, 0);
  assert.equal(result.requireAllCases, 0);
  assert.equal(result.recallAt5, 1);
});

test('legacy keys keep their values in the presence of the new fields', (t) => {
  const plain = fixture(t, [{id: 'p', query: 'shared needle alpha', relevant: ['one.md'], category: 'x'}]);
  const withNew = fixture(t, [{id: 'p', query: 'shared needle alpha', relevant: ['one.md'], category: 'x', expectedHeading: 'First section', requireAll: true}]);
  const a = runEval({...plain, now: NOW, repeat: 1, extended: true});
  const b = runEval({...withNew, now: NOW, repeat: 1, extended: true});
  for (const key of ['recallAt5', 'precisionAt5', 'abstainAccuracy', 'trToEnRecallAt5', 'n', 'mrrAt10', 'ndcgAt10', 'byCategory', 'falsePositives', 'abstainThreshold']) {
    assert.deepEqual(b[key], a[key], key);
  }
});

test('default output keeps the legacy key set; new keys are opt-in via extended', (t) => {
  const paths = fixture(t, [{id: 'plain', query: 'shared needle alpha', relevant: ['one.md']}]);
  const plain = runEval({...paths, now: NOW, repeat: 1});
  assert.equal('sectionHitRate' in plain, false);
  assert.equal('requireAllCases' in plain, false);
  const extended = runEval({...paths, now: NOW, repeat: 1, extended: true});
  assert.equal('sectionHitRate' in extended, true);
  assert.equal('requireAllRate' in extended, true);
});
