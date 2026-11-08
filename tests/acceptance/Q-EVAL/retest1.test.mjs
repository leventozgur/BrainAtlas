// SPDX-License-Identifier: MIT
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runEval } from '../../../eval/run-eval.mjs';
import { buildIndex, loadPages, search } from '../../../packages/core/src/retrieval/index.mjs';

const runner = resolve('eval/run-eval.mjs');
const now = new Date('2025-01-01T00:00:00Z');
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'q-eval-retest-'));
  t.after(() => rmSync(dir, {recursive:true, force:true}));
  const corpusDir = join(dir, 'corpus'); mkdirSync(corpusDir);
  writeFileSync(join(corpusDir, 'normal.md'), '# Quartz\nquartz\n');
  const casesFile = join(dir, 'cases.json');
  return {dir, corpusDir, casesFile, put: cases => writeFileSync(casesFile, JSON.stringify(cases))};
}
function cli(f, ...args) {
  return spawnSync(process.execPath, [runner, '--corpus', f.corpusDir, '--cases', f.casesFile, '--now', now.toISOString(), '--json', ...args], {encoding:'utf8', env:{...process.env, HOME:f.dir, TMPDIR:f.dir}});
}

test('threshold controls weak matches in library and CLI', t => {
  const f = fixture(t);
  const query = 'quartz zirconium xenon neon argon krypton radon helium';
  const index = buildIndex(loadPages(f.corpusDir), {now});
  const weak = search(index, query, {limit:10, asOf:now});
  assert.ok(weak.results.length && weak.results[0].score < 0.35);
  f.put([{id:'weak',query,relevant:[],abstain:true}]);
  const options = {corpusDir:f.corpusDir,casesFile:f.casesFile,now};
  assert.equal(runEval(options).abstainAccuracy,0);
  const result = runEval({...options,abstainThreshold:0.35});
  assert.equal(result.abstainThreshold,0.35); assert.equal(result.abstainAccuracy,1);
  assert.deepEqual(result.falsePositives,[]);
  const p = cli(f,'--abstain-threshold','0.35'); assert.equal(p.status,0);
  assert.equal(JSON.parse(p.stdout).abstainAccuracy,1);
  for (const value of [0,1]) assert.equal(runEval({...options,abstainThreshold:value}).abstainThreshold,value);
  for (const value of [-1,2,NaN,'abc','']) assert.throws(() => runEval({...options,abstainThreshold:value}));
});

test('CLI rejects invalid and empty thresholds without stdout', t => {
  const f = fixture(t); f.put([]);
  for (const value of ['-1','2','abc','']) {
    const p = cli(f,'--abstain-threshold',value);
    assert.notEqual(p.status,0,`accepted ${JSON.stringify(value)}`);
    assert.equal(p.stdout,'');
  }
});

test('redacts secret IDs and filenames but preserves ordinary IDs', t => {
  const f = fixture(t); const secret = ['sk','test'+'v'.repeat(24)].join('-');
  writeFileSync(join(f.corpusDir, `${secret}.md`), '# Zirconium\nzirconium\n');
  f.put([{id:secret,query:'zirconium',relevant:[],abstain:true},{id:'ordinary-1',query:'quartz',relevant:[],abstain:true}]);
  const p = cli(f,'--verbose'); assert.equal(p.status,0);
  assert.ok(!(p.stdout+p.stderr).includes(secret));
  const hits = JSON.parse(p.stdout).falsePositives;
  assert.deepEqual(hits,[{caseId:'[redacted]',path:'[redacted]'},{caseId:'ordinary-1',path:'normal.md'}]);
});

test('category Unicode and length/control boundaries', t => {
  const f = fixture(t);
  f.put(['Türkçe', 'a'.repeat(63), 'b'.repeat(64), 'c'.repeat(65), 'bad\nname'].map((category,i) => ({id:String(i),query:'quartz',relevant:['normal.md'],category})));
  const result = runEval({corpusDir:f.corpusDir,casesFile:f.casesFile,now});
  assert.equal(result.byCategory['Türkçe'].n,1); assert.equal(result.byCategory['a'.repeat(63)].n,1); assert.equal(result.byCategory['b'.repeat(64)].n,1); // PM correction: spec says names up to 64 chars are kept
  assert.equal(result.byCategory.uncategorized.n,2);
  assert.equal(Object.values(result.byCategory).reduce((n,c) => n+c.n,0),5);
});

test('invalid query fails CLI silently on stdout and preserves library behavior', t => {
  const f = fixture(t); f.put([{id:'bad',query:42,relevant:[],abstain:true}]);
  const p = cli(f); assert.notEqual(p.status,0); assert.equal(p.stdout,'');
  const result = runEval({corpusDir:f.corpusDir,casesFile:f.casesFile,now});
  assert.equal(result.n,1); assert.equal(result.abstainAccuracy,0);
});
