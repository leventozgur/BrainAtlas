// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { evaluateGate, getMetric } from '../../eval/gate.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const baseline = {natural: {recallAt5: 0.7}, hook: {injectionPrecision: 0.1}};

test('KEEP when every primary and guard passes; delta and value thresholds', () => {
  const candidate = {natural: {recallAt5: 0.76}, hook: {injectionPrecision: 0.1}};
  const keep = evaluateGate({baseline, candidate, criteria: {
    primary: [{metric: 'natural.recallAt5', op: '>=', delta: 0.05}],
    guards: [{metric: 'hook.injectionPrecision', op: '>=', value: 0.1}],
  }});
  assert.equal(keep.decision, 'KEEP');
  assert.equal(keep.criteria[0].threshold, 0.75);
  assert.equal(keep.criteria[0].result, 'PASS');
  assert.equal(keep.criteria[1].threshold, 0.1);
});

test('DISCARD when a primary is not met even though guards pass', () => {
  const candidate = {natural: {recallAt5: 0.72}, hook: {injectionPrecision: 0.1}};
  const outcome = evaluateGate({baseline, candidate, criteria: {
    primary: [{metric: 'natural.recallAt5', op: '>=', delta: 0.05}],
    guards: [],
  }});
  assert.equal(outcome.decision, 'DISCARD');
  assert.equal(outcome.criteria[0].result, 'FAIL');
});

test('DISCARD when a guard regresses beyond its delta', () => {
  const candidate = {natural: {recallAt5: 0.9}, hook: {injectionPrecision: 0.05}};
  const outcome = evaluateGate({baseline, candidate, criteria: {
    primary: [{metric: 'natural.recallAt5', op: '>=', delta: 0.05}],
    guards: [{metric: 'hook.injectionPrecision', op: '>=', delta: -0.01}],
  }});
  assert.equal(outcome.decision, 'DISCARD');
  assert.equal(outcome.criteria[1].result, 'FAIL');
  assert.equal(outcome.criteria[1].group, 'guard');
});

test('a missing metric in either document fails the criterion; it never passes silently', () => {
  const candidate = {natural: {}};
  const outcome = evaluateGate({baseline, candidate, criteria: {
    primary: [{metric: 'natural.recallAt5', op: '>=', value: 0}],
    guards: [{metric: 'natural.nope', op: '<=', value: 1}],
  }});
  assert.equal(outcome.decision, 'DISCARD');
  assert.deepEqual(outcome.criteria.map((item) => item.result), ['FAIL', 'FAIL']);
  assert.equal(outcome.criteria[0].candidate, null);
  assert.equal(getMetric(baseline, 'constructor.name'), undefined);
});

test('operators <= and == and value thresholds behave as written', () => {
  const candidate = {m: {a: 0.5, b: 0.25}};
  const baseOut = {m: {a: 0.5, b: 0.25}};
  const outcome = evaluateGate({baseline: baseOut, candidate, criteria: {
    primary: [
      {metric: 'm.a', op: '<=', value: 0.5},
      {metric: 'm.b', op: '==', delta: 0},
      {metric: 'm.a', op: '==', value: 0.4},
    ],
  }});
  assert.deepEqual(outcome.criteria.map((item) => item.result), ['PASS', 'PASS', 'FAIL']);
  assert.equal(outcome.decision, 'DISCARD');
});

test('empty primary list and malformed criteria are rejected', () => {
  const ok = {m: {a: 1}};
  assert.throws(() => evaluateGate({baseline: ok, candidate: ok, criteria: {primary: []}}), /Invalid criteria/);
  assert.throws(() => evaluateGate({baseline: ok, candidate: ok, criteria: {primary: [{metric: 'm.a', op: '!=', value: 1}]}}), /Invalid criteria/);
  assert.throws(() => evaluateGate({baseline: ok, candidate: ok, criteria: {primary: [{metric: 'm.a', op: '>=', value: 1, delta: 0}]}}), /Invalid criteria/);
  assert.throws(() => evaluateGate({baseline: ok, candidate: ok, criteria: {primary: [{metric: 'm.a', op: '>=', value: 'x'}]}}), /Invalid criteria/);
  assert.throws(() => evaluateGate({baseline: ok, candidate: ok, criteria: {primary: [{metric: '', op: '>=', value: 1}]}}), /Invalid criteria/);
});

test('dotted metric lookup uses own properties only', () => {
  assert.equal(getMetric({a: {b: 2}}, 'a.b'), 2);
  assert.equal(getMetric({a: {}}, 'a.toString'), undefined);
  assert.equal(getMetric({a: 1}, 'a.b'), undefined);
});

test('CLI exit codes: KEEP 0, DISCARD 1, invalid input 2', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ba00-gate-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const write = (name, value) => { const file = path.join(dir, name); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); return file; };
  const base = write('base.json', baseline);
  const keepCand = write('keep.json', {natural: {recallAt5: 0.8}, hook: {injectionPrecision: 0.1}});
  const discardCand = write('discard.json', {natural: {recallAt5: 0.7}, hook: {injectionPrecision: 0.1}});
  const criteria = write('criteria.json', {primary: [{metric: 'natural.recallAt5', op: '>=', delta: 0.05}], guards: [{metric: 'hook.injectionPrecision', op: '>=', delta: -0.01}]});
  const badCriteria = write('bad.json', {primary: []});
  const broken = write('broken.json', '{not json');
  const run = (args) => spawnSync(process.execPath, [path.join(root, 'eval/gate.mjs'), ...args], {encoding: 'utf8'});

  const keep = run(['--baseline', base, '--candidate', keepCand, '--criteria', criteria, '--json']);
  assert.equal(keep.status, 0, keep.stderr);
  assert.equal(JSON.parse(keep.stdout).decision, 'KEEP');
  const discard = run(['--baseline', base, '--candidate', discardCand, '--criteria', criteria, '--json']);
  assert.equal(discard.status, 1);
  assert.equal(JSON.parse(discard.stdout).decision, 'DISCARD');
  assert.match(run(['--baseline', base, '--candidate', keepCand, '--criteria', criteria]).stdout, /decision: KEEP/);

  for (const args of [
    ['--baseline', base, '--candidate', keepCand],
    ['--baseline', base, '--candidate', keepCand, '--criteria', badCriteria],
    ['--baseline', base, '--candidate', broken, '--criteria', criteria],
    ['--baseline', path.join(dir, 'missing.json'), '--candidate', keepCand, '--criteria', criteria],
  ]) {
    const result = run(args);
    assert.equal(result.status, 2, args.join(' '));
    assert.equal(result.stdout, '');
    assert.equal(result.stderr.trim(), 'Invalid input');
  }
});
