// SPDX-License-Identifier: MIT
// BA-31m: top1RelevantRate, top1ExcludedRate and the withCwd summary, checked against hand-computed toy records.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = process.env.BA_ROOT ?? fileURLToPath(new URL('../../', import.meta.url));
const load = (rel) => import(pathToFileURL(path.join(root, rel)).href);
const { summarizeHookRecords } = await load('eval/lib/hook-records.mjs');
const { runHookCases } = await load('eval/hook-eval.mjs');

const dirs = [];
after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

const rec = (over) => ({
  category: 'c',
  kind: 'knowledge',
  cwd: null,
  excluded: [],
  abstain: false,
  relevant: [],
  injected: [],
  chars: 0,
  durationMs: 1,
  meta: [],
  poisoned: false,
  sectionHit: null,
  sectionSource: null,
  ...over,
});

test('top1RelevantRate: answerable record without injection counts in the denominator only', () => {
  const m = summarizeHookRecords([
    rec({ relevant: ['a.md'], injected: ['a.md'] }),
    rec({ relevant: ['a.md'], injected: [] }),
    rec({ relevant: ['a.md'], injected: ['b.md', 'a.md'] }),
    rec({ abstain: true, injected: ['a.md'], relevant: ['a.md'] }),
  ]);
  assert.equal(m.top1RelevantRate, 1 / 3);
});

test('top1ExcludedRate: abstain records are included; empty, missing and non-array excluded are not', () => {
  const noField = rec({ injected: ['x.md'] });
  delete noField.excluded;
  const m = summarizeHookRecords([
    rec({ abstain: true, excluded: ['x.md'], injected: ['x.md'] }),
    rec({ excluded: ['x.md', 'y.md'], injected: ['y.md'] }),
    rec({ excluded: ['x.md'], injected: [] }),
    rec({ excluded: [], injected: ['x.md'] }),
    rec({ excluded: 'x.md', injected: ['x.md'] }),
    noField,
  ]);
  assert.equal(m.top1ExcludedRate, 2 / 3);
});

test('withCwd groups every record whose cwd is a string, the empty string included', () => {
  const m = summarizeHookRecords([
    rec({ cwd: 'p', relevant: ['a.md'], injected: ['a.md'], excluded: ['b.md'] }),
    rec({ cwd: '', relevant: ['a.md'], injected: ['b.md'], excluded: ['b.md'] }),
    rec({ cwd: 'p', abstain: true, injected: [] }),
    rec({ cwd: null, relevant: ['a.md'], injected: ['a.md'] }),
    rec({ cwd: 4, relevant: ['a.md'], injected: ['a.md'] }),
  ]);
  assert.deepEqual(m.withCwd, {
    n: 3,
    injectionRate: 2 / 3,
    missRate: 1 / 2, // answerable: first two records; the second misses
    precision: 1 / 2, // two injected paths, one relevant
    falseInjectionRate: 0, // the only abstain record injected nothing
    top1RelevantRate: 1 / 2,
    top1ExcludedRate: 1 / 2, // excluded non-empty on the first two; only the second injected its excluded page first
  });
});

test('withCwd is all zeros when no record carries a cwd string; an empty list gives zeros too', () => {
  const zero = {
    n: 0,
    injectionRate: 0,
    missRate: 0,
    precision: 0,
    falseInjectionRate: 0,
    top1RelevantRate: 0,
    top1ExcludedRate: 0,
  };
  assert.deepEqual(summarizeHookRecords([rec({ relevant: ['a.md'], injected: ['a.md'] })]).withCwd, zero);
  const empty = summarizeHookRecords([]);
  assert.deepEqual(empty.withCwd, zero);
  assert.equal(empty.top1RelevantRate, 0);
  assert.equal(empty.top1ExcludedRate, 0);
});

test('no NaN or Infinity anywhere, including all-abstain input', () => {
  const walk = (v) => (typeof v === 'number' ? [v] : v && typeof v === 'object' ? Object.values(v).flatMap(walk) : []);
  for (const records of [
    [],
    [rec({ abstain: true })],
    [rec({ abstain: true, cwd: '', excluded: ['x.md'], injected: ['x.md'] })],
  ]) {
    for (const n of walk(summarizeHookRecords(records))) assert.ok(Number.isFinite(n));
  }
});

test('existing keys keep their values and group key sets; exactly three keys are added', () => {
  const records = [
    rec({ category: 'a', relevant: ['a.md'], injected: ['a.md', 'b.md'], cwd: 'p', excluded: ['b.md'] }),
    rec({ category: 'b', abstain: true, injected: ['x.md'] }),
    rec({ category: 'b', kind: 'operational', abstain: true }),
  ];
  const m = summarizeHookRecords(records);
  const base = summarizeHookRecords(records.map((r) => ({ ...r, cwd: null, excluded: [] })));
  assert.deepEqual(
    Object.keys(m)
      .filter((k) => ['top1ExcludedRate', 'top1RelevantRate', 'withCwd'].includes(k))
      .sort(),
    ['top1ExcludedRate', 'top1RelevantRate', 'withCwd']
  );
  const oldKeys = Object.keys(m)
    .filter((k) => !['top1ExcludedRate', 'top1RelevantRate', 'withCwd'].includes(k))
    .sort();
  assert.deepEqual(oldKeys, [
    'byCategory',
    'byKind',
    'chars',
    'charsPerHit',
    'durationMs',
    'falseInjectionRate',
    'injectedChars',
    'injectionPrecision',
    'injectionRate',
    'metaShareTop5',
    'missRate',
    'n',
    'neededPageInjected',
    'poisonInjected',
    'sectionCases',
    'sectionHitAt1',
    'sectionHitSources',
  ]);
  assert.equal(m.injectionRate, 2 / 3);
  assert.equal(m.injectionPrecision, 1 / 3);
  assert.equal(m.falseInjectionRate, 1 / 2);
  assert.deepEqual(Object.keys(m.byCategory), ['a', 'b']);
  for (const g of Object.values(m.byCategory))
    assert.deepEqual(Object.keys(g).sort(), ['injectionRate', 'missRate', 'n', 'precision']);
  for (const g of Object.values(m.byKind))
    assert.deepEqual(Object.keys(g).sort(), ['falseInjectionRate', 'injectionRate', 'missRate', 'n', 'precision']);
  for (const k of oldKeys) assert.deepEqual(m[k], base[k], k); // cwd and excluded never change an existing key
});

test('runHookCases records excluded: string items only, order kept; cwd string or null', async () => {
  const corpusDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ba31m-vis-'));
  dirs.push(corpusDir);
  fs.writeFileSync(
    path.join(corpusDir, 'alpha.md'),
    '---\ntitle: Zyqorvex gateway\nstatus: active\n---\n# Zyqorvex gateway\n\nThe zyqorvex gateway applies a timeout for each zyqorvex call.\n'
  );
  const cases = [
    {
      id: 'e1',
      query: 'zyqorvex gateway timeout',
      relevant: ['alpha.md'],
      excluded: ['b.md', 3, 'a.md', null],
      cwd: '',
    },
    { id: 'e2', query: 'zyqorvex gateway timeout', relevant: ['alpha.md'], excluded: 'alpha.md', cwd: 9 },
    { id: 'e3', query: 'zyqorvex gateway timeout', relevant: ['alpha.md'] },
  ];
  const records = await runHookCases({ corpusDir, cases, abstainThreshold: 0.35 });
  assert.deepEqual(
    records.map((r) => r.excluded),
    [['b.md', 'a.md'], [], []]
  );
  assert.deepEqual(
    records.map((r) => r.cwd),
    ['', null, null]
  );
});
