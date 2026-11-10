// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runHookEval, runHookCases } from '../../eval/hook-eval.mjs';
import { parseInjectedPaths, summarizeHookRecords } from '../../eval/lib/hook-records.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NOW = new Date('2026-11-10T00:00:00Z');

function fixture(t, cases) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ba00-hook-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const corpusDir = path.join(dir, 'corpus');
  fs.mkdirSync(corpusDir);
  fs.writeFileSync(path.join(corpusDir, 'alpha.md'), '# Alpha\nzebra quartz ember notes about the alpha item.\n');
  fs.writeFileSync(path.join(corpusDir, 'beta.md'), '# Beta\nmarble lantern orbit notes about the beta item.\n');
  fs.writeFileSync(path.join(corpusDir, 'gamma.md'), '# Gamma\nunrelated cedar river text for the gamma item.\n');
  const casesFile = path.join(dir, 'cases.json');
  fs.writeFileSync(casesFile, JSON.stringify(cases));
  return {dir, corpusDir, casesFile};
}

// Hand-calculated fixture: every query term sits in exactly one page, so a matching page scores
// sqrt(0.4) = 0.632 (above the 0.35 threshold) and a page without matches is never injected.
const CASES = [
  {id: 'c1', category: 'a', query: 'zebra quartz ember', relevant: ['alpha.md']},
  {id: 'c2', category: 'a', query: 'marble lantern', relevant: ['gamma.md']},
  {id: 'c3', category: 'b', query: 'nonexistent word', relevant: [], abstain: true},
  {id: 'c4', category: 'b', query: 'zebra', relevant: [], abstain: true},
];

test('hook metrics match hand-calculated values on the fixture', async (t) => {
  const f = fixture(t, CASES);
  const result = await runHookEval({corpusDir: f.corpusDir, casesFile: f.casesFile, now: NOW, abstainThreshold: 0.35});
  assert.equal(result.n, 4);
  assert.equal(result.injectionRate, 0.75);
  assert.ok(Math.abs(result.injectionPrecision - 1 / 3) < 1e-12);
  assert.equal(result.missRate, 0.5);
  assert.equal(result.falseInjectionRate, 0.5);
  assert.deepEqual(Object.keys(result).sort(), ['byCategory', 'chars', 'durationMs', 'falseInjectionRate', 'injectionPrecision', 'injectionRate', 'missRate', 'n'].sort());
  assert.deepEqual(Object.keys(result.chars).sort(), ['mean', 'p50', 'p95']);
  assert.deepEqual(Object.keys(result.durationMs).sort(), ['p50', 'p95']);
  assert.ok(result.chars.mean > 0 && result.chars.p95 >= result.chars.p50);
  assert.ok(result.durationMs.p95 >= result.durationMs.p50);
  assert.deepEqual(Object.keys(result.byCategory), ['a', 'b']);
  assert.deepEqual(result.byCategory.a, {n: 2, injectionRate: 1, missRate: 0.5, precision: 0.5});
  assert.deepEqual(result.byCategory.b, {n: 2, injectionRate: 0.5, missRate: 0, precision: 0});
});

test('per-case records expose the injected paths in the real hook output', async (t) => {
  const f = fixture(t, CASES);
  const records = await runHookCases({corpusDir: f.corpusDir, cases: CASES, now: NOW, abstainThreshold: 0.35});
  assert.deepEqual(records.map((r) => r.injected), [['alpha.md'], ['beta.md'], [], ['alpha.md']]);
  assert.equal(records.every((r) => r.chars >= 0), true);
});

test('no injection at all: precision and false injection are zero, misses count answerable cases', async (t) => {
  const f = fixture(t, CASES);
  const result = await runHookEval({corpusDir: f.corpusDir, casesFile: f.casesFile, now: NOW, abstainThreshold: 1});
  assert.equal(result.injectionRate, 0);
  assert.equal(result.injectionPrecision, 0);
  assert.equal(result.missRate, 1);
  assert.equal(result.falseInjectionRate, 0);
  assert.equal(result.chars.mean, 0);
});

test('all cases abstain: no miss denominator, precision over injected paths only', async (t) => {
  const abstainOnly = CASES.filter((c) => c.abstain);
  const f = fixture(t, abstainOnly);
  const result = await runHookEval({corpusDir: f.corpusDir, casesFile: f.casesFile, now: NOW, abstainThreshold: 0.35});
  assert.equal(result.n, 2);
  assert.equal(result.injectionRate, 0.5);
  assert.equal(result.injectionPrecision, 0);
  assert.equal(result.missRate, 0);
  assert.equal(result.falseInjectionRate, 0.5);
});

test('empty case file yields zeroed metrics', async (t) => {
  const f = fixture(t, []);
  const result = await runHookEval({corpusDir: f.corpusDir, casesFile: f.casesFile, now: NOW});
  assert.equal(result.n, 0);
  assert.equal(result.injectionRate, 0);
  assert.equal(result.injectionPrecision, 0);
  assert.equal(result.missRate, 0);
  assert.equal(result.falseInjectionRate, 0);
  assert.deepEqual(result.byCategory, {});
});

test('malformed case JSON and invalid options fail without partial output', async (t) => {
  const f = fixture(t, CASES);
  fs.writeFileSync(f.casesFile, '[{"id":');
  await assert.rejects(() => runHookEval({corpusDir: f.corpusDir, casesFile: f.casesFile, now: NOW}));
  const valid = fixture(t, CASES);
  await assert.rejects(() => runHookEval({corpusDir: valid.corpusDir, casesFile: valid.casesFile, now: NOW, mode: 'manual'}), /Invalid mode/);
  await assert.rejects(() => runHookEval({corpusDir: valid.corpusDir, casesFile: valid.casesFile, now: NOW, abstainThreshold: 2}), /Invalid abstain threshold/);
  const cli = spawnSync(process.execPath, [path.join(root, 'eval/hook-eval.mjs'), '--corpus', f.corpusDir, '--cases', f.casesFile, '--json'], {encoding: 'utf8'});
  assert.equal(cli.status, 1);
  assert.equal(cli.stdout, '');
  assert.equal(cli.stderr.trim(), 'Hook eval failed');
});

test('CLI prints one JSON document with the contract keys', (t) => {
  const f = fixture(t, CASES);
  const cli = spawnSync(process.execPath, [path.join(root, 'eval/hook-eval.mjs'), '--corpus', f.corpusDir, '--cases', f.casesFile, '--json', '--now', NOW.toISOString()], {encoding: 'utf8'});
  assert.equal(cli.status, 0, cli.stderr);
  const result = JSON.parse(cli.stdout);
  assert.equal(result.injectionRate, 0.75);
  assert.equal(cli.stdout.includes('zebra'), false);
});

test('parseInjectedPaths accepts only block-leading title lines of known corpus paths', () => {
  const known = new Set(['alpha.md', 'beta.md']);
  const context = 'Alpha (alpha.md)\nzebra text\n\nBeta (beta.md)\n# Heading (alpha.md)\nmarble (beta.md)\n\nGhost (ghost.md)\nx\n\nBeta again (beta.md)\ny';
  assert.deepEqual(parseInjectedPaths(context, known), ['alpha.md', 'beta.md']);
  assert.deepEqual(parseInjectedPaths('', known), []);
  assert.deepEqual(parseInjectedPaths(undefined, known), []);
});

test('summarizeHookRecords computes precision, misses and per-category values', () => {
  const records = [
    {category: 'x', abstain: false, relevant: ['a.md', 'b.md'], injected: ['a.md', 'c.md'], chars: 10, durationMs: 1},
    {category: 'x', abstain: false, relevant: ['d.md'], injected: [], chars: 0, durationMs: 3},
    {category: 'y', abstain: true, relevant: [], injected: ['e.md'], chars: 5, durationMs: 2},
  ];
  const result = summarizeHookRecords(records);
  assert.equal(result.n, 3);
  assert.ok(Math.abs(result.injectionRate - 2 / 3) < 1e-12);
  assert.equal(result.injectionPrecision, 1 / 3);
  assert.equal(result.missRate, 0.5);
  assert.equal(result.falseInjectionRate, 1);
  assert.equal(result.chars.mean, 5);
  assert.deepEqual(result.byCategory.x, {n: 2, injectionRate: 0.5, missRate: 0.5, precision: 0.5});
  assert.deepEqual(result.byCategory.y, {n: 1, injectionRate: 1, missRate: 0, precision: 0});
});
