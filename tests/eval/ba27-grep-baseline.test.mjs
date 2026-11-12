// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { grepRanking, grepTerms, runGrepBaseline } from '../../eval/grep-baseline.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ba27-grep-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const corpus = path.join(dir, 'corpus');
  fs.mkdirSync(path.join(corpus, 'sub'), {recursive: true});
  fs.writeFileSync(path.join(corpus, 'alpha.md'), '# Alpha\nzebra quartz ember\nzebra again\n');
  fs.writeFileSync(path.join(corpus, 'beta.md'), '# Beta\nzebra only once\n');
  fs.writeFileSync(path.join(corpus, 'gamma.md'), '# Gamma\nquartz quartz\nember\n');
  fs.writeFileSync(path.join(corpus, 'sub', 'delta.md'), '# Delta\nunrelated cedar river\n');
  return {dir, corpus};
}

test('query terms are folded for Turkish and drop stop words; no stemming', () => {
  assert.deepEqual(grepTerms('Işık ve ÇİLEK nasıl?'), ['isik', 'cilek']);
  assert.deepEqual(grepTerms('the zebra of Ökçe'), ['zebra', 'okce']);
  assert.deepEqual(grepTerms('zebra zebra quartz'), ['zebra', 'quartz']);
  assert.deepEqual(grepTerms('the and of'), []);
});

test('ranking: distinct matched terms first, then matching-line total, then path; only matching files are returned', (t) => {
  const f = fixture(t);
  // alpha has all three terms; gamma has quartz and ember (2 distinct); beta has only zebra; delta matches nothing.
  assert.deepEqual(grepRanking(f.corpus, 'zebra quartz ember'), ['alpha.md', 'gamma.md', 'beta.md']);
  // alpha has two zebra lines, beta one.
  assert.deepEqual(grepRanking(f.corpus, 'zebra'), ['alpha.md', 'beta.md']);
  // Equal distinct and total counts fall back to the path.
  assert.deepEqual(grepRanking(f.corpus, 'quartz'), ['alpha.md', 'gamma.md']);
  assert.deepEqual(grepRanking(f.corpus, 'cedar river'), ['sub/delta.md']);
  assert.deepEqual(grepRanking(f.corpus, 'nothing matches here'), []);
});

test('metrics: recallAt5 and mrrAt10 follow the BM25 definitions; currentFirstRate covers current-state cases only', (t) => {
  const f = fixture(t);
  const casesFile = path.join(f.dir, 'cases.json');
  fs.writeFileSync(casesFile, JSON.stringify([
    {id: 'a', query: 'zebra quartz ember', relevant: ['alpha.md']},
    {id: 'b', query: 'zebra only', relevant: ['beta.md'], category: 'current-state'},
    {id: 'c', query: 'cedar river', relevant: [], abstain: true},
    {id: 'd', query: 'quartz', relevant: ['beta.md']},
  ]));
  const result = runGrepBaseline({corpusDir: f.corpus, casesFile});
  assert.equal(result.n, 4);
  assert.equal(result.currentCases, 1);
  // Answerable: a, b, d. a ranks alpha first (rr 1). b ranks beta first (rr 1, current-state hit). d matches alpha and gamma
  // only (quartz), so beta is never ranked and d scores 0. recallAt5 = (1 + 1 + 0) / 3 and mrrAt10 = (1 + 1 + 0) / 3.
  assert.ok(Math.abs(result.recallAt5 - 2 / 3) < 1e-12, `recall ${result.recallAt5}`);
  assert.ok(Math.abs(result.mrrAt10 - 2 / 3) < 1e-12, `mrr ${result.mrrAt10}`);
  assert.equal(result.currentFirstRate, 1);
});

test('a case file with no current-state cases reports a null currentFirstRate', (t) => {
  const f = fixture(t);
  const casesFile = path.join(f.dir, 'plain.json');
  fs.writeFileSync(casesFile, JSON.stringify([{id: 'a', query: 'ember', relevant: ['alpha.md']}]));
  assert.equal(runGrepBaseline({corpusDir: f.corpus, casesFile}).currentFirstRate, null);
});

test('rg mode gives the same ordering as the JS path when rg is installed (local cross-check, skipped otherwise)', (t) => {
  const probe = spawnSync('rg', ['--version'], {encoding: 'utf8'});
  if (probe.status !== 0) return t.skip('rg not installed');
  const f = fixture(t);
  for (const query of ['zebra quartz ember', 'zebra', 'cedar river', 'quartz ember']) {
    assert.deepEqual(grepRanking(f.corpus, query, {rg: true}), grepRanking(f.corpus, query), query);
  }
});

test('CLI prints one JSON line and rejects missing arguments', (t) => {
  const f = fixture(t);
  const casesFile = path.join(f.dir, 'cli.json');
  fs.writeFileSync(casesFile, JSON.stringify([{id: 'a', query: 'zebra', relevant: ['alpha.md']}]));
  const cli = spawnSync(process.execPath, [path.join(root, 'eval/grep-baseline.mjs'), '--corpus', f.corpus, '--cases', casesFile], {encoding: 'utf8'});
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).n, 1);
  const bad = spawnSync(process.execPath, [path.join(root, 'eval/grep-baseline.mjs'), '--corpus', f.corpus], {encoding: 'utf8'});
  assert.equal(bad.status, 1);
  assert.equal(bad.stderr.trim(), 'Grep baseline failed');
});
