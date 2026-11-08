// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runEval } from '../../eval/run-eval.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
function fixture(t, cases) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-fixture-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const corpusDir = path.join(dir, 'corpus');
  fs.mkdirSync(corpusDir);
  for (const [name, content] of Object.entries({
    'a.md': 'shared needle evidence',
    'b.md': 'shared needle evidence',
    'c.md': 'shared needle evidence',
  })) fs.writeFileSync(path.join(corpusDir, name), content);
  const casesFile = path.join(dir, 'cases.json');
  fs.writeFileSync(casesFile, JSON.stringify(cases));
  return {corpusDir, casesFile};
}

test('hand calculated MRR and binary nDCG; category counts cover every case', (t) => {
  const paths = fixture(t, [
    {id: 'ranked', query: 'shared needle', relevant: ['b.md', 'c.md'], category: 'retrieval', excluded: ['c.md']},
    {id: 'empty', query: 'shared needle', relevant: [], abstain: true, category: 'abstain'},
  ]);
  const result = runEval({...paths, now: new Date('2025-01-01T00:00:00Z'), repeat: 2});
  assert.equal(result.mrrAt10, 0.5);
  const expectedNdcg = (1 / Math.log2(3) + 1 / Math.log2(4)) / (1 + 1 / Math.log2(3));
  assert.ok(Math.abs(result.ndcgAt10 - expectedNdcg) < 1e-12);
  assert.deepEqual(result.byCategory, {
    abstain: {n: 1, recallAt5: 0, mrrAt10: 0},
    retrieval: {n: 1, recallAt5: 1, mrrAt10: 0.5},
  });
  assert.equal(Object.values(result.byCategory).reduce((sum, item) => sum + item.n, 0), result.n);
  assert.ok(result.falsePositives.some((item) => item.caseId === 'empty' && item.path === 'a.md'));
  assert.ok(result.falsePositives.some((item) => item.caseId === 'ranked' && item.path === 'c.md'));
  assert.ok(result.falsePositives.every((item) => Object.keys(item).sort().join(',') === 'caseId,path'));
  assert.equal(result.latencyMs.count, 4);
  assert.ok(Number.isFinite(result.latencyMs.p50));
  assert.ok(Number.isFinite(result.latencyMs.p95));
  assert.ok(result.latencyMs.p95 >= result.latencyMs.p50);
  assert.ok(Number.isFinite(result.indexBuildMs));
  assert.equal(JSON.stringify(result).includes('shared needle'), false);
});

test('legacy dev metrics retain their original values and original keys', () => {
  const result = runEval({
    corpusDir: path.join(root, 'eval/corpus'),
    casesFile: path.join(root, 'eval/dev/cases.json'),
    now: new Date('2025-01-01T00:00:00.000Z'),
  });
  assert.deepEqual({
    recallAt5: result.recallAt5,
    precisionAt5: result.precisionAt5,
    abstainAccuracy: result.abstainAccuracy,
    trToEnRecallAt5: result.trToEnRecallAt5,
    n: result.n,
  }, {
    recallAt5: 1,
    precisionAt5: 0.2000000000000001,
    abstainAccuracy: 1,
    trToEnRecallAt5: 1,
    n: 46,
  });
});

test('CLI --json emits one valid JSON document and accepts repeat count', () => {
  const proc = spawnSync(process.execPath, [
    path.join(root, 'eval/run-eval.mjs'), '--json', '--repeat', '1',
    '--corpus', path.join(root, 'eval/corpus'),
    '--cases', path.join(root, 'eval/dev/cases.json'),
    '--now', '2025-01-01T00:00:00.000Z',
  ], {cwd: root, encoding: 'utf8'});
  assert.equal(proc.status, 0, proc.stderr);
  const result = JSON.parse(proc.stdout);
  assert.equal(result.n, 46);
  assert.equal(result.latencyMs.count, 46);
  assert.equal(proc.stdout.trim().startsWith('{'), true);
});
