// SPDX-License-Identifier: MIT
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { ROOT, runNode, tempDir, removeDir } from './helpers.mjs';

const DEFAULT_KEYS = [
  'abstainAccuracy',
  'abstainThreshold',
  'byCategory',
  'falsePositives',
  'indexBuildMs',
  'latencyMs',
  'mrrAt10',
  'n',
  'ndcgAt10',
  'precisionAt5',
  'recallAt5',
  'trToEnRecallAt5',
].sort();
const EXTENDED_KEYS = ['requireAllCases', 'requireAllRate', 'sectionCases', 'sectionHitRate'];
const TIMING = new Set(['latencyMs', 'indexBuildMs']);
const stripTiming = (o) => JSON.parse(JSON.stringify(o, (k, v) => (TIMING.has(k) ? undefined : v)));

const DATASETS = [
  { name: 'dev/cases.json', corpus: 'eval/corpus', cases: 'eval/dev/cases.json' },
  { name: 'natural', corpus: 'eval/corpus-natural', cases: 'eval/dev/natural-cases.json' },
  { name: 'xling', corpus: 'eval/corpus-natural', cases: 'eval/dev/xling-cases.json' },
];

const SANDBOX = tempDir('compat-sandbox');
process.on('exit', () => removeDir(SANDBOX));

function runAt(root, dataset, extra = []) {
  const res = runNode(
    [
      join(root, 'eval', 'run-eval.mjs'),
      '--corpus',
      join(root, dataset.corpus),
      '--cases',
      join(root, dataset.cases),
      '--now',
      '2026-11-10T00:00:00Z',
      '--json',
      ...extra,
    ],
    { cwd: root, env: { TMPDIR: SANDBOX, HOME: SANDBOX } }
  );
  assert.equal(res.status, 0, `${root} ${dataset.name}: ${res.stderr}`);
  return JSON.parse(res.stdout);
}

test('default output has exactly the historical key set (no extended keys leak into default mode)', () => {
  for (const ds of DATASETS) {
    const ours = runAt(ROOT, ds);
    assert.deepEqual(Object.keys(ours).sort(), DEFAULT_KEYS, ds.name);
  }
});

test('--extended adds the four opt-in keys and leaves default values unchanged', () => {
  for (const ds of DATASETS) {
    const plain = stripTiming(runAt(ROOT, ds));
    const ext = runAt(ROOT, ds, ['--extended']);
    assert.deepEqual(Object.keys(ext).sort(), [...DEFAULT_KEYS, ...EXTENDED_KEYS].sort(), ds.name);
    const { sectionHitRate, sectionCases, requireAllRate, requireAllCases, ...rest } = stripTiming(ext);
    assert.deepEqual(rest, plain, ds.name);
    assert.equal(sectionCases, 0, `${ds.name}: no expectedHeading in legacy set`);
    assert.equal(requireAllCases, 0, `${ds.name}: no requireAll in legacy set`);
    assert.equal(sectionHitRate, 0);
    assert.equal(requireAllRate, 0);
  }
});

test('--extended on a new set reports the labelled counts (current-state 11 expectedHeading, multihop 14 requireAll)', () => {
  const cs = runAt(ROOT, { corpus: 'eval/corpus-ba', cases: 'eval/dev/current-state-cases.json' }, ['--extended']);
  assert.equal(cs.sectionCases, 11);
  const mh = runAt(ROOT, { corpus: 'eval/corpus-ba', cases: 'eval/dev/multihop-cases.json' }, ['--extended']);
  assert.equal(mh.requireAllCases, 14);
  assert.ok(mh.requireAllRate >= 0 && mh.requireAllRate <= 1);
});

test('run-eval --extended is accepted as a flag and does not consume a value', () => {
  const dir = tempDir('compat-args');
  try {
    const res = runNode(
      [
        join(ROOT, 'eval', 'run-eval.mjs'),
        '--corpus',
        join(ROOT, 'eval/corpus'),
        '--cases',
        join(ROOT, 'eval/dev/cases.json'),
        '--extended',
        '--repeat',
        '1',
        '--json',
      ],
      { env: { TMPDIR: dir } }
    );
    assert.equal(res.status, 0, res.stderr);
    assert.ok('sectionHitRate' in JSON.parse(res.stdout));
  } finally {
    removeDir(dir);
  }
});
