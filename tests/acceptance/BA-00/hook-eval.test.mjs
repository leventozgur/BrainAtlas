// SPDX-License-Identifier: MIT
// BA-00 blind acceptance: hook-eval metrics against hand-computed expectations on a tiny private corpus.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runHookCases, runHookEval } from '../../../eval/hook-eval.mjs';
import { ROOT, runNode, tempDir, removeDir, listDir } from './helpers.mjs';

// Private fixture: each page has one distinctive token that appears nowhere else.
const PAGES = {
  'alpha.md': ['Zyqorvex gateway', 'The zyqorvex gateway accepts requests and applies a timeout of thirty seconds for each zyqorvex call.'],
  'sub/beta.md': ['Quillfrost ledger', 'The quillfrost ledger stores double entry records for every quillfrost account.'],
  'gamma.md': ['Mornwick basin', 'Mornwick basin describes the regional cache layout for the mornwick cluster.'],
};

function makeCorpus() {
  const dir = tempDir('hook-corpus');
  for (const [rel, [title, body]] of Object.entries(PAGES)) {
    const file = join(dir, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `---\ntitle: ${title}\nstatus: active\ngenerated: "2026-06-01"\n---\n# ${title}\n\n${body}\n`, 'utf8');
  }
  return dir;
}

const c = (id, category, query, relevant = [], abstain = false) => ({ id, category, query, relevant, abstain });
const CASES_DIR = tempDir('hook-cases');
process.on('exit', () => removeDir(CASES_DIR));
let caseSeq = 0;
const casesPath = () => join(CASES_DIR, `cases-${caseSeq++}.json`);

// Run a function with TMPDIR pointed at a private directory so hook state dirs can be checked for cleanup.
async function withPrivateTmp(fn) {
  const priv = tempDir('hook-state');
  const prev = process.env.TMPDIR;
  process.env.TMPDIR = priv;
  try {
    return await fn(priv);
  } finally {
    if (prev === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = prev;
    removeDir(priv);
  }
}

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `expected ${b}, got ${a}`);

test('scenario 1 mixed set: every metric equals the hand calculation', async () => {
  const corpusDir = makeCorpus();
  const cases = [
    c('m1', 'identifier', 'zyqorvex gateway timeout', ['alpha.md']),          // answerable, injects alpha -> hit
    c('m2', 'multihop', 'quillfrost ledger', ['alpha.md']),                   // answerable, injects beta -> miss (wrong label on purpose)
    c('m3', 'near-negative', 'unknownterm xqzzy', [], true),                  // abstain, nothing injected -> correct
    c('m4', 'near-negative', 'zyqorvex', [], true),                           // abstain, alpha injected -> false injection
  ];
  const casesFile = casesPath();
  writeFileSync(casesFile, JSON.stringify(cases), 'utf8');
  try {
    const records = await withPrivateTmp(() => runHookCases({ corpusDir, cases, abstainThreshold: 0.35 }));
    // Sanity on what the real hook injected (precondition for the arithmetic below).
    assert.deepEqual(records.map((r) => r.injected), [['alpha.md'], ['sub/beta.md'], [], ['alpha.md']]);

    const m = await withPrivateTmp(() => runHookEval({ corpusDir, casesFile, abstainThreshold: 0.35 }));
    assert.equal(m.n, 4);
    close(m.injectionRate, 3 / 4);            // m1, m2, m4 inject at least one path
    close(m.injectionPrecision, 1 / 3);       // 3 injected paths, 1 relevant (alpha in m1)
    close(m.missRate, 1 / 2);                 // answerable m1 (hit), m2 (miss)
    close(m.falseInjectionRate, 1 / 2);       // abstain m3 (none), m4 (injected)
    assert.deepEqual(Object.keys(m).sort(), ['byCategory', 'chars', 'durationMs', 'falseInjectionRate', 'injectionPrecision', 'injectionRate', 'missRate', 'n']);
    close(m.byCategory['identifier'].injectionRate, 1);
    close(m.byCategory['identifier'].missRate, 0);
    close(m.byCategory['identifier'].precision, 1);
    close(m.byCategory['multihop'].injectionRate, 1);
    close(m.byCategory['multihop'].missRate, 1);
    close(m.byCategory['multihop'].precision, 0);
    close(m.byCategory['near-negative'].n, 2);
    close(m.byCategory['near-negative'].injectionRate, 1 / 2);
    close(m.byCategory['near-negative'].precision, 0);

    // chars: computed from the same per-case context lengths the hook produced.
    const lengths = records.map((r) => r.chars).sort((x, y) => x - y);
    close(m.chars.mean, lengths.reduce((s, v) => s + v, 0) / 4);
    close(m.chars.p50, lengths[1]);           // ceil(0.5*4)-1 = 1
    close(m.chars.p95, lengths[3]);           // ceil(0.95*4)-1 = 3
    assert.ok(m.durationMs.p50 >= 0 && m.durationMs.p95 >= m.durationMs.p50);
  } finally {
    removeDir(corpusDir);
  }
});

test('scenario 2 nothing injected: rates are 0 (never NaN) and misses count answerable cases', async () => {
  const corpusDir = makeCorpus();
  const cases = [
    c('n1', 'identifier', 'unknownterm xqzzy', [], true),
    c('n2', 'near-negative', 'unknownterm qqq', [], true),
    c('n3', 'identifier', 'unknownterm qqq zzz', ['alpha.md']),
  ];
  const casesFile = casesPath();
  writeFileSync(casesFile, JSON.stringify(cases), 'utf8');
  try {
    const m = await withPrivateTmp(() => runHookEval({ corpusDir, casesFile, abstainThreshold: 0.35 }));
    close(m.injectionRate, 0);
    close(m.injectionPrecision, 0);
    close(m.missRate, 1);
    close(m.falseInjectionRate, 0);
    assert.equal(m.chars.p95, 0);
  } finally {
    removeDir(corpusDir);
  }
});

test('scenario 3 all abstain and all injected: falseInjectionRate 1, precision 0, missRate 0', async () => {
  const corpusDir = makeCorpus();
  const cases = [c('a1', 'near-negative', 'zyqorvex', [], true), c('a2', 'near-negative', 'zyqorvex call', [], true)];
  const casesFile = casesPath();
  writeFileSync(casesFile, JSON.stringify(cases), 'utf8');
  try {
    const m = await withPrivateTmp(() => runHookEval({ corpusDir, casesFile, abstainThreshold: 0.35 }));
    close(m.injectionRate, 1);
    close(m.injectionPrecision, 0);
    close(m.missRate, 0);
    close(m.falseInjectionRate, 1);
  } finally {
    removeDir(corpusDir);
  }
});

test('scenario 4 single answerable case and repeated query: each case has its own session, so both inject', async () => {
  const corpusDir = makeCorpus();
  const one = [c('s1', 'identifier', 'mornwick cluster layout', ['gamma.md'])];
  const two = [c('d1', 'identifier', 'mornwick cluster layout', ['gamma.md']), c('d2', 'identifier', 'mornwick cluster layout', ['gamma.md'])];
  const f1 = casesPath();
  const f2 = casesPath();
  writeFileSync(f1, JSON.stringify(one), 'utf8');
  writeFileSync(f2, JSON.stringify(two), 'utf8');
  try {
    const m1 = await withPrivateTmp(() => runHookEval({ corpusDir, casesFile: f1, abstainThreshold: 0.35 }));
    assert.equal(m1.n, 1);
    close(m1.injectionRate, 1);
    close(m1.injectionPrecision, 1);
    close(m1.missRate, 0);
    close(m1.falseInjectionRate, 0);

    const m2 = await withPrivateTmp(() => runHookEval({ corpusDir, casesFile: f2, abstainThreshold: 0.35 }));
    assert.equal(m2.n, 2);
    close(m2.injectionRate, 1);
    close(m2.injectionPrecision, 1);
  } finally {
    removeDir(corpusDir);
  }
});

test('scenario 5 empty case list: all metrics are zero and nothing throws', async () => {
  const corpusDir = makeCorpus();
  const casesFile = casesPath();
  writeFileSync(casesFile, '[]', 'utf8');
  try {
    const m = await withPrivateTmp(() => runHookEval({ corpusDir, casesFile }));
    assert.equal(m.n, 0);
    close(m.injectionRate, 0);
    close(m.injectionPrecision, 0);
    close(m.missRate, 0);
    close(m.falseInjectionRate, 0);
    assert.deepEqual(m.byCategory, {});
  } finally {
    removeDir(corpusDir);
  }
});

test('scenario 6 abstainThreshold 1 suppresses every injection (scores stay below 1)', async () => {
  const corpusDir = makeCorpus();
  const cases = [c('t1', 'identifier', 'zyqorvex gateway timeout', ['alpha.md']), c('t2', 'near-negative', 'zyqorvex', [], true)];
  const casesFile = casesPath();
  writeFileSync(casesFile, JSON.stringify(cases), 'utf8');
  try {
    const m = await withPrivateTmp(() => runHookEval({ corpusDir, casesFile, abstainThreshold: 1 }));
    close(m.injectionRate, 0);
    close(m.falseInjectionRate, 0);
    close(m.missRate, 1);
  } finally {
    removeDir(corpusDir);
  }
});

test('input validation: invalid mode, threshold, or cases are rejected', async () => {
  const corpusDir = makeCorpus();
  try {
    await assert.rejects(runHookCases({ corpusDir, cases: [], mode: 'bogus' }), /Invalid mode/);
    await assert.rejects(runHookCases({ corpusDir, cases: [], abstainThreshold: 1.5 }), /Invalid abstain threshold/);
    await assert.rejects(runHookCases({ corpusDir, cases: 'nope' }), /Invalid cases/);
  } finally {
    removeDir(corpusDir);
  }
});

test('CLI: --json output matches runHookEval and leaves no hook state behind', async () => {
  const corpusDir = makeCorpus();
  const dir = tempDir('hook-cli');
  const casesFile = join(dir, 'cases.json');
  const tmp = tempDir('hook-cli-tmp');
  writeFileSync(casesFile, JSON.stringify([c('x1', 'identifier', 'mornwick cluster layout', ['gamma.md']), c('x2', 'near-negative', 'unknownterm xqzzy', [], true)]), 'utf8');
  try {
    const res = runNode([join(ROOT, 'eval', 'hook-eval.mjs'), '--corpus', corpusDir, '--cases', casesFile, '--json'], { env: { TMPDIR: tmp, HOME: tmp } });
    assert.equal(res.status, 0, res.stderr);
    const cli = JSON.parse(res.stdout);
    const direct = await withPrivateTmp(() => runHookEval({ corpusDir, casesFile, abstainThreshold: 0.35, now: new Date('2026-11-10T00:00:00Z') }));
    const strip = (o) => JSON.parse(JSON.stringify(o, (k, v) => (k === 'durationMs' ? undefined : v)));
    assert.deepEqual(strip(cli), strip(direct));
    assert.deepEqual(listDir(tmp), [], 'hook state directory must be removed');
  } finally {
    removeDir(corpusDir);
    removeDir(dir);
    removeDir(tmp);
  }
});

test('CLI: invalid mode exits 1 with a generic message and no metrics on stdout', () => {
  const corpusDir = makeCorpus();
  const dir = tempDir('hook-cli-bad');
  const casesFile = join(dir, 'cases.json');
  writeFileSync(casesFile, '[]', 'utf8');
  try {
    const res = runNode([join(ROOT, 'eval', 'hook-eval.mjs'), '--corpus', corpusDir, '--cases', casesFile, '--mode', 'bogus']);
    assert.equal(res.status, 1);
    assert.equal(res.stdout, '');
    assert.match(res.stderr, /Hook eval failed/);
  } finally {
    removeDir(corpusDir);
    removeDir(dir);
  }
});
