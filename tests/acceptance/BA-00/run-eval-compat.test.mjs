// SPDX-License-Identifier: MIT
// BA-00 blind acceptance (criterion 2): run-eval default output keys and values equal main's on the same corpus and cases.
// The main checkout is only executed, never written to.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { ROOT, runNode, git, tempDir, removeDir } from './helpers.mjs';

const DEFAULT_KEYS = [
  'abstainAccuracy', 'abstainThreshold', 'byCategory', 'falsePositives', 'indexBuildMs', 'latencyMs',
  'mrrAt10', 'n', 'ndcgAt10', 'precisionAt5', 'recallAt5', 'trToEnRecallAt5',
].sort();
const EXTENDED_KEYS = ['requireAllCases', 'requireAllRate', 'sectionCases', 'sectionHitRate'];
const TIMING = new Set(['latencyMs', 'indexBuildMs']);
const stripTiming = (o) => JSON.parse(JSON.stringify(o, (k, v) => (TIMING.has(k) ? undefined : v)));

function mainCheckout() {
  const list = git(['worktree', 'list', '--porcelain']).stdout.split('\n');
  const first = list.find((l) => l.startsWith('worktree '));
  assert.ok(first, 'git worktree list must name the main checkout');
  return first.slice('worktree '.length);
}

// PM fix (2026-11-11): the comparison with the main checkout only makes sense on the BA-00 track branch; on main,
// in CI (single detached checkout) and on later tracks that intentionally change ranking, it is skipped.
const ON_TRACK = git(['rev-parse', '--abbrev-ref', 'HEAD']).stdout?.trim() === 'track/BA-00';
const ONLY_ON_TRACK = { skip: !ON_TRACK };
const MAIN = ON_TRACK ? mainCheckout() : null;
const DATASETS = [
  { name: 'dev/cases.json', corpus: 'eval/corpus', cases: 'eval/dev/cases.json' },
  { name: 'natural', corpus: 'eval/corpus-natural', cases: 'eval/dev/natural-cases.json' },
  { name: 'xling', corpus: 'eval/corpus-natural', cases: 'eval/dev/xling-cases.json' },
];

const SANDBOX = tempDir('compat-sandbox');
process.on('exit', () => removeDir(SANDBOX));

function runAt(root, dataset, extra = []) {
  const res = runNode([join(root, 'eval', 'run-eval.mjs'), '--corpus', join(root, dataset.corpus), '--cases', join(root, dataset.cases), '--now', '2026-11-10T00:00:00Z', '--json', ...extra], { cwd: root, env: { TMPDIR: SANDBOX, HOME: SANDBOX } });
  assert.equal(res.status, 0, `${root} ${dataset.name}: ${res.stderr}`);
  return JSON.parse(res.stdout);
}

test('main checkout is the branch main (read-only comparison source)', ONLY_ON_TRACK, () => {
  const branch = git(['symbolic-ref', '--short', 'HEAD'], MAIN).stdout.trim();
  assert.equal(branch, 'main');
});

test('default output has exactly the historical key set (no extended keys leak into default mode)', () => {
  for (const ds of DATASETS) {
    const ours = runAt(ROOT, ds);
    assert.deepEqual(Object.keys(ours).sort(), DEFAULT_KEYS, ds.name);
  }
});

test('default output values equal main on identical corpus and cases (timing fields excluded)', ONLY_ON_TRACK, () => {
  for (const ds of DATASETS) {
    const ours = stripTiming(runAt(ROOT, ds));
    const theirs = stripTiming(runAt(MAIN, ds));
    assert.deepEqual(ours, theirs, ds.name);
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
    const res = runNode([join(ROOT, 'eval', 'run-eval.mjs'), '--corpus', join(ROOT, 'eval/corpus'), '--cases', join(ROOT, 'eval/dev/cases.json'), '--extended', '--repeat', '1', '--json'], { env: { TMPDIR: dir } });
    assert.equal(res.status, 0, res.stderr);
    assert.ok('sectionHitRate' in JSON.parse(res.stdout));
  } finally {
    removeDir(dir);
  }
});
