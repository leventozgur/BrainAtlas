// SPDX-License-Identifier: MIT
// BA-00 blind acceptance: gate KEEP/DISCARD logic, boundaries, missing metrics, invalid input and exit codes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { evaluateGate, getMetric, parseCriteria } from '../../../eval/gate.mjs';
import { ROOT, runNode, tempDir, removeDir } from './helpers.mjs';

const GATE = join(ROOT, 'eval', 'gate.mjs');
const base = { m: { recall: 0.5 }, lat: { p95: 300 }, x: 0.1, flag: 1 };

test('delta >=: threshold is baseline + delta, boundary passes, just below fails', () => {
  const criteria = { primary: [{ metric: 'm.recall', op: '>=', delta: 0.1 }] };
  const at = evaluateGate({ baseline: base, candidate: { m: { recall: 0.6 } }, criteria });
  assert.equal(at.decision, 'KEEP');
  assert.equal(at.criteria[0].threshold, 0.6);
  assert.equal(at.criteria[0].result, 'PASS');
  const below = evaluateGate({ baseline: base, candidate: { m: { recall: 0.5999 } }, criteria });
  assert.equal(below.decision, 'DISCARD');
  assert.equal(below.criteria[0].result, 'FAIL');
});

test('value >=: absolute threshold; boundary passes, just below fails', () => {
  const criteria = { primary: [{ metric: 'm.recall', op: '>=', value: 0.7 }] };
  assert.equal(evaluateGate({ baseline: base, candidate: { m: { recall: 0.7 } }, criteria }).decision, 'KEEP');
  assert.equal(evaluateGate({ baseline: base, candidate: { m: { recall: 0.69 } }, criteria }).decision, 'DISCARD');
});

test('<= with value and with negative delta: boundary inclusive', () => {
  const byValue = { primary: [{ metric: 'lat.p95', op: '<=', value: 300 }] };
  assert.equal(evaluateGate({ baseline: base, candidate: { lat: { p95: 300 } }, criteria: byValue }).decision, 'KEEP');
  assert.equal(evaluateGate({ baseline: base, candidate: { lat: { p95: 300.5 } }, criteria: byValue }).decision, 'DISCARD');
  const byDelta = { primary: [{ metric: 'lat.p95', op: '<=', delta: -10 }] };
  const ok = evaluateGate({ baseline: base, candidate: { lat: { p95: 290 } }, criteria: byDelta });
  assert.equal(ok.criteria[0].threshold, 290);
  assert.equal(ok.decision, 'KEEP');
  assert.equal(evaluateGate({ baseline: base, candidate: { lat: { p95: 291 } }, criteria: byDelta }).decision, 'DISCARD');
});

test('==: exact match passes, tiny float noise passes, a visible difference fails', () => {
  const criteria = { primary: [{ metric: 'flag', op: '==', value: 1 }] };
  assert.equal(evaluateGate({ baseline: base, candidate: { ...base, flag: 1 }, criteria }).decision, 'KEEP');
  assert.equal(evaluateGate({ baseline: base, candidate: { ...base, flag: 1 + 1e-13 }, criteria }).decision, 'KEEP');
  assert.equal(evaluateGate({ baseline: base, candidate: { ...base, flag: 1.01 }, criteria }).decision, 'DISCARD');
});

test('float boundary: 0.1 + 0.2 threshold accepts the exact decimal 0.3', () => {
  const criteria = { primary: [{ metric: 'x', op: '>=', delta: 0.2 }] };
  assert.equal(evaluateGate({ baseline: base, candidate: { ...base, x: 0.3 }, criteria }).decision, 'KEEP');
});

test('missing or non-numeric metrics FAIL and never pass silently', () => {
  const primary = (metric) => ({ primary: [{ metric, op: '>=', value: 0 }] });
  const cand = { m: { recall: 0.9 }, lat: { p95: 1 } };
  assert.equal(evaluateGate({ baseline: base, candidate: cand, criteria: primary('m.missing') }).decision, 'DISCARD');
  assert.equal(evaluateGate({ baseline: base, candidate: { m: { recall: '0.9' } }, criteria: primary('m.recall') }).decision, 'DISCARD');
  assert.equal(evaluateGate({ baseline: base, candidate: { m: 5 }, criteria: primary('m.recall') }).decision, 'DISCARD');
  assert.equal(evaluateGate({ baseline: base, candidate: cand, criteria: primary('m.recall.deeper') }).decision, 'DISCARD');
  assert.equal(evaluateGate({ baseline: base, candidate: cand, criteria: primary('constructor') }).decision, 'DISCARD');
  // delta criterion without a baseline value: threshold cannot be computed, so FAIL.
  const noBase = evaluateGate({ baseline: {}, candidate: cand, criteria: { primary: [{ metric: 'm.recall', op: '>=', delta: -1 }] } });
  assert.equal(noBase.decision, 'DISCARD');
  assert.equal(noBase.criteria[0].result, 'FAIL');
  // Design as implemented: a value criterion still reads the baseline document, so a missing baseline fails it.
  assert.equal(evaluateGate({ baseline: {}, candidate: cand, criteria: primary('m.recall') }).decision, 'DISCARD');
});

test('guards: a failing guard discards even when every primary passes; guard group is labelled', () => {
  const criteria = {
    primary: [{ metric: 'm.recall', op: '>=', delta: 0 }],
    guards: [{ metric: 'lat.p95', op: '<=', value: 250 }],
  };
  const res = evaluateGate({ baseline: base, candidate: { m: { recall: 0.9 }, lat: { p95: 300 } }, criteria });
  assert.equal(res.decision, 'DISCARD');
  assert.deepEqual(res.criteria.map((c) => [c.group, c.result]), [['primary', 'PASS'], ['guard', 'FAIL']]);
  assert.equal(evaluateGate({ baseline: base, candidate: { m: { recall: 0.9 }, lat: { p95: 200 } }, criteria }).decision, 'KEEP');
});

test('invalid criteria throw: empty primary, both delta and value, neither, bad op, bad metric, non-finite, array root', () => {
  const bad = [
    { primary: [] },
    { guards: [{ metric: 'a', op: '>=', value: 1 }] },
    { primary: [{ metric: 'a', op: '>=', delta: 1, value: 1 }] },
    { primary: [{ metric: 'a', op: '>=' }] },
    { primary: [{ metric: 'a', op: '!=', value: 1 }] },
    { primary: [{ metric: 'a..b', op: '>=', value: 1 }] },
    { primary: [{ metric: '', op: '>=', value: 1 }] },
    { primary: [{ metric: 'a', op: '>=', value: '1' }] },
    { primary: [{ metric: 'a', op: '>=', delta: Infinity }] },
    { primary: [{ metric: 'a', op: '>=', value: 1 }], guards: 'nope' },
    [],
  ];
  for (const criteria of bad) {
    assert.throws(() => parseCriteria(criteria), /Invalid criteria/);
    assert.throws(() => evaluateGate({ baseline: base, candidate: base, criteria }), /Invalid criteria/);
  }
});

test('getMetric reads only own dotted paths', () => {
  assert.equal(getMetric({ a: { b: 2 } }, 'a.b'), 2);
  assert.equal(getMetric({ a: 1 }, 'a.b'), undefined);
  assert.equal(getMetric({}, 'toString'), undefined);
  assert.equal(getMetric(null, 'a'), undefined);
});

// ---- CLI ----
function writeJson(dir, name, value) {
  const file = join(dir, name);
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
  return file;
}

test('CLI exit codes: KEEP 0, DISCARD 1, invalid input 2, and text output lists decision', () => {
  const dir = tempDir('gate-cli');
  try {
    const baseline = writeJson(dir, 'base.json', base);
    const keepCand = writeJson(dir, 'keep.json', { m: { recall: 0.6 }, lat: { p95: 300 }, x: 0.1, flag: 1 });
    const discardCand = writeJson(dir, 'discard.json', { m: { recall: 0.55 }, lat: { p95: 300 }, x: 0.1, flag: 1 });
    const criteria = writeJson(dir, 'criteria.json', { primary: [{ metric: 'm.recall', op: '>=', delta: 0.1 }] });

    const keep = runNode([GATE, '--baseline', baseline, '--candidate', keepCand, '--criteria', criteria]);
    assert.equal(keep.status, 0);
    assert.match(keep.stdout, /PASS primary m\.recall >= threshold=0\.6/);
    assert.match(keep.stdout, /decision: KEEP/);

    const discard = runNode([GATE, '--baseline', baseline, '--candidate', discardCand, '--criteria', criteria]);
    assert.equal(discard.status, 1);
    assert.match(discard.stdout, /decision: DISCARD/);

    const json = runNode([GATE, '--baseline', baseline, '--candidate', keepCand, '--criteria', criteria, '--json']);
    assert.equal(json.status, 0);
    assert.equal(JSON.parse(json.stdout).decision, 'KEEP');

    const broken = writeJson(dir, 'broken.json', '{not json');
    const badJson = runNode([GATE, '--baseline', broken, '--candidate', keepCand, '--criteria', criteria]);
    assert.equal(badJson.status, 2);
    assert.match(badJson.stderr, /Invalid input/);

    const arr = writeJson(dir, 'arr.json', '[1,2]');
    assert.equal(runNode([GATE, '--baseline', arr, '--candidate', keepCand, '--criteria', criteria]).status, 2);

    const badOp = writeJson(dir, 'badop.json', { primary: [{ metric: 'm.recall', op: '!=', value: 1 }] });
    assert.equal(runNode([GATE, '--baseline', baseline, '--candidate', keepCand, '--criteria', badOp]).status, 2);

    assert.equal(runNode([GATE, '--baseline', baseline, '--candidate', keepCand]).status, 2);
    assert.equal(runNode([GATE, '--baseline', baseline, '--candidate', keepCand, '--criteria', criteria, '--bogus', 'x']).status, 2);
  } finally {
    removeDir(dir);
  }
});

test('CLI: a missing metric in the candidate is a DISCARD (exit 1), not a crash', () => {
  const dir = tempDir('gate-missing');
  try {
    const baseline = writeJson(dir, 'base.json', base);
    const candidate = writeJson(dir, 'cand.json', { m: {} });
    const criteria = writeJson(dir, 'criteria.json', { primary: [{ metric: 'm.recall', op: '>=', value: 0 }] });
    const res = runNode([GATE, '--baseline', baseline, '--candidate', candidate, '--criteria', criteria]);
    assert.equal(res.status, 1);
    assert.match(res.stdout, /FAIL primary m\.recall/);
  } finally {
    removeDir(dir);
  }
});
