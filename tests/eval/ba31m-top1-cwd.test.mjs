// SPDX-License-Identifier: MIT
// BA-31m: withCwd subsummary, top1RelevantRate and top1ExcludedRate, checked against values computed by hand
// on toy records (no retrieval involved).
import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeHookRecords } from '../../eval/lib/hook-records.mjs';

const close = (a, b, msg = '') => assert.ok(Math.abs(a - b) < 1e-9, `${msg} expected ${b}, got ${a}`);
const rec = (over) => ({ category: 'c', kind: 'knowledge', cwd: null, abstain: false, relevant: [], excluded: [], injected: [], chars: 0, durationMs: 1, meta: [], poisoned: false, sectionHit: null, sectionSource: null, ...over });

// R1: cwd a, answerable, first block relevant; excluded page injected second only.
// R2: cwd b, answerable, first block is the excluded (other project) page.
// R3: operational abstain, no cwd, nothing injected.
// R4: cwd a, answerable, nothing injected (miss, no excluded list).
// R5: no cwd, answerable, first block relevant; excluded page not injected.
const TOY = [
  rec({ cwd: '/srv/work/a', relevant: ['a.md'], excluded: ['b.md'], injected: ['a.md', 'b.md'] }),
  rec({ cwd: '/srv/work/b', relevant: ['c.md'], excluded: ['a.md'], injected: ['a.md'] }),
  rec({ kind: 'operational', abstain: true }),
  rec({ cwd: '/srv/work/a', relevant: ['d.md'] }),
  rec({ relevant: ['e.md'], excluded: ['f.md'], injected: ['e.md'] }),
];

test('BA-31m top-level top1 rates: relevant 2 of 4 answerable; excluded 1 of 3 cases with an excluded list', () => {
  const m = summarizeHookRecords(TOY);
  close(m.top1RelevantRate, 2 / 4, 'top1RelevantRate');
  close(m.top1ExcludedRate, 1 / 3, 'top1ExcludedRate');
});

test('BA-31m withCwd: only cases with a cwd (R1, R2, R4), same group shape plus the top-1 rates', () => {
  const w = summarizeHookRecords(TOY).withCwd;
  assert.deepEqual(Object.keys(w).sort(), ['falseInjectionRate', 'injectionRate', 'missRate', 'n', 'precision', 'top1ExcludedRate', 'top1RelevantRate']);
  assert.equal(w.n, 3);
  close(w.injectionRate, 2 / 3, 'injectionRate: R1, R2 inject');
  close(w.missRate, 2 / 3, 'missRate: answerable R1, R2, R4; R1 hits');
  close(w.precision, 1 / 3, 'precision: 1 relevant of 3 injected blocks');
  close(w.falseInjectionRate, 0, 'no abstain or operational case with a cwd');
  close(w.top1RelevantRate, 1 / 3, 'top1RelevantRate: only R1 of R1, R2, R4');
  close(w.top1ExcludedRate, 1 / 2, 'top1ExcludedRate: R2 of R1, R2');
});

test('BA-31m: existing keys keep their values on the same records', () => {
  const m = summarizeHookRecords(TOY);
  close(m.injectionRate, 3 / 5, 'injectionRate');
  close(m.injectionPrecision, 2 / 4, 'injectionPrecision: relevant injected blocks a.md, e.md of 4');
  close(m.missRate, 2 / 4, 'missRate');
  close(m.byCategory.c.precision, 2 / 4, 'byCategory precision unchanged');
  assert.equal(m.byCategory.c.n, 5);
  assert.deepEqual(Object.keys(m.byCategory.c).sort(), ['injectionRate', 'missRate', 'n', 'precision']);
});

test('BA-31m: no cwd cases and no excluded lists give a zero withCwd summary and zero rates, never NaN', () => {
  const m = summarizeHookRecords([rec({ injected: ['x.md'], relevant: ['y.md'] })]);
  assert.equal(m.withCwd.n, 0);
  assert.equal(m.top1ExcludedRate, 0);
  assert.equal(m.withCwd.top1RelevantRate, 0);
  assert.equal(m.withCwd.top1ExcludedRate, 0);
  close(m.top1RelevantRate, 0, 'top1RelevantRate: first block is not relevant');
  const empty = summarizeHookRecords([]);
  assert.equal(empty.top1RelevantRate, 0);
  assert.equal(empty.withCwd.n, 0);
});
