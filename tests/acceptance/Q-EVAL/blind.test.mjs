// SPDX-License-Identifier: MIT
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runEval } from '../../../eval/run-eval.mjs';
import { buildIndex, loadPages, search } from '../../../packages/core/src/retrieval/index.mjs';

const root = resolve('.');
const runner = join(root, 'eval/run-eval.mjs');
const now = new Date('2025-01-01T00:00:00Z');
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'q-eval-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const corpus = join(dir, 'corpus'); mkdirSync(corpus);
  for (const name of ['a', 'b', 'c']) writeFileSync(join(corpus, `${name}.md`), '# Quartz\nquartz quartz\n');
  const cases = join(dir, 'cases.json');
  const put = data => writeFileSync(cases, JSON.stringify(data));
  return {dir, corpus, cases, put};
}
function cli(f, ...args) {
  return spawnSync(process.execPath, [runner, '--corpus', f.corpus, '--cases', f.cases, '--now', now.toISOString(), ...args], {encoding:'utf8', env:{...process.env, HOME:f.dir, TMPDIR:f.dir}});
}

test('hand computed ranks, multi relevance, missing hit and category totals', t => {
  const f = fixture(t);
  const paths = search(buildIndex(loadPages(f.corpus), {now}), 'quartz', {limit:10, asOf:now}).results.map(x => x.path);
  assert.deepEqual(paths, ['a.md', 'b.md', 'c.md']);
  f.put([
    {id:'first', query:'quartz', relevant:['a.md'], category:'rank'},
    {id:'third', query:'quartz', relevant:['c.md'], category:'rank'},
    {id:'missing', query:'quartz', relevant:['missing.md']},
    {id:'multi', query:'quartz', relevant:['b.md','c.md'], category:'multi'},
    {id:'abstain', query:'unfindable', relevant:[], abstain:true}
  ]);
  const out = runEval({corpusDir:f.corpus, casesFile:f.cases, now, repeat:2});
  const discount = rank => 1 / Math.log2(rank + 1);
  const expectedNdcg = (1 + discount(3) + 0 + (discount(2) + discount(3)) / (discount(1) + discount(2))) / 4;
  assert.ok(Math.abs(out.mrrAt10 - (1 + 1/3 + 0 + 1/2)/4) < 1e-12);
  assert.ok(Math.abs(out.ndcgAt10 - expectedNdcg) < 1e-12);
  assert.equal(Object.values(out.byCategory).reduce((n, c) => n+c.n, 0), out.n);
  assert.equal(out.byCategory.rank.n, 2); assert.equal(out.byCategory.uncategorized.n, 2);
  assert.equal(out.latencyMs.count, 10);
  for (const x of [out.latencyMs.p50, out.latencyMs.p95, out.indexBuildMs]) assert.ok(Number.isFinite(x) && x >= 0);
  assert.ok(out.latencyMs.p95 >= out.latencyMs.p50);
  const again = runEval({corpusDir:f.corpus, casesFile:f.cases, now, repeat:2});
  for (const key of Object.keys(out).filter(k => !['latencyMs','indexBuildMs'].includes(k))) assert.deepEqual(again[key], out[key]);
});

test('default dev regression and single JSON CLI', () => {
  const out = spawnSync(process.execPath, [runner, '--json'], {encoding:'utf8'});
  assert.equal(out.status, 0); assert.equal(out.stderr, '');
  const data = JSON.parse(out.stdout);
  assert.deepEqual([data.recallAt5, data.precisionAt5, data.abstainAccuracy, data.trToEnRecallAt5, data.n], [1, 0.2000000000000001, 1, 1, 46]);
  assert.equal(data.latencyMs.count, 138);
});

test('false positives contain only case ID and path, no query or page content', t => {
  const f = fixture(t); const secret = ['sk', 'test'+'x'.repeat(24)].join('-');
  writeFileSync(join(f.corpus,'a.md'), `# Quartz\nquartz quartz ${secret} PRIVATECONTENT\n`);
  f.put([{id:'abstain',query:'quartz',relevant:[],abstain:true,excluded:['b.md']}, {id:'excluded',query:'quartz',relevant:['a.md'],excluded:['c.md']}]);
  const p = cli(f, '--json', '--verbose'); assert.equal(p.status, 0);
  const data = JSON.parse(p.stdout); assert.ok(data.falsePositives.length >= 3);
  for (const hit of data.falsePositives) assert.deepEqual(Object.keys(hit).sort(), ['caseId','path']);
  for (const forbidden of [secret,'PRIVATECONTENT','quartz']) assert.ok(!(p.stdout+p.stderr).includes(forbidden));
});

test('empty cases and invalid repeat arguments', t => {
  const f = fixture(t); f.put([]);
  const p = cli(f,'--json','--repeat','1'); assert.equal(p.status,0);
  const out = JSON.parse(p.stdout); assert.equal(out.n,0); assert.deepEqual(out.latencyMs,{p50:0,p95:0,count:0});
  for (const value of ['0','1001','-1','1.5','no']) assert.notEqual(cli(f,'--repeat',value).status,0);
});

test('malformed input and missing files fail without disclosing content', t => {
  const f = fixture(t); const secret = ['sk', 'test'+'z'.repeat(24)].join('-');
  writeFileSync(f.cases, `{ "${secret}":`);
  const p = cli(f,'--json','--verbose'); assert.notEqual(p.status,0); assert.equal(p.stdout,''); assert.ok(!p.stderr.includes(secret));
  f.put({not:'an array'}); assert.notEqual(cli(f,'--json').status,0);
  rmSync(f.cases); assert.notEqual(cli(f,'--json').status,0);
});

test('symlinks and traversal do not expose outside corpus and no writes to HOME', t => {
  const f = fixture(t); const secret = ['sk','test'+'y'.repeat(24)].join('-');
  writeFileSync(join(f.dir,'outside.md'), `# Outsideterm\n${secret}`);
  symlinkSync(join(f.dir,'outside.md'), join(f.corpus,'link.md'));
  f.put([{id:'escape',query:'outsideterm',relevant:['../outside.md'],excluded:['../outside.md']}]);
  const before = readdirSync(f.dir).sort(); const p = cli(f,'--json','--verbose');
  assert.equal(p.status,0); assert.ok(!(p.stdout+p.stderr).includes(secret));
  const data = JSON.parse(p.stdout); assert.equal(data.recallAt5,0); assert.deepEqual(data.falsePositives,[]);
  assert.deepEqual(readdirSync(f.dir).sort(),before);
});

test('sensitive file names and case IDs never escape in metrics or logs', t => {
  const f = fixture(t); const secret = ['sk','test'+'q'.repeat(24)].join('-');
  writeFileSync(join(f.corpus, `${secret}.md`), '# Exclusiveterm\nexclusiveterm\n');
  f.put([{id:secret,query:'exclusiveterm',relevant:[],abstain:true}]);
  const p = cli(f,'--json','--verbose'); assert.equal(p.status,0);
  assert.ok(!(p.stdout+p.stderr).includes(secret), 'secret exposed in CLI output');
});

test('category names retain valid user supplied text', t => {
  const f = fixture(t); f.put([{id:'one',query:'quartz',relevant:['a.md'],category:'Türkçe kategori'}]);
  const out = runEval({corpusDir:f.corpus,casesFile:f.cases,now});
  assert.equal(out.byCategory['Türkçe kategori']?.n,1);
});

test('invalid query does not masquerade as a correct abstention', t => {
  const f = fixture(t); f.put([{id:'invalid',query:42,relevant:[],abstain:true}]);
  const p = cli(f,'--json'); assert.notEqual(p.status,0);
});

test('semantic gate can invoke the legacy runEval interface', async t => {
  const f = fixture(t);
  const {semanticGate} = await import('../../../modules/semantic/src/eval.mjs');
  const provider = {id:'local-test', dims:2, embed: async texts => texts.map(() => [1,0])};
  const result = await semanticGate({devCases:[{id:'x',query:'quartz',relevant:['a.md']}],corpusDir:f.corpus,provider});
  assert.equal(typeof result.enable,'boolean');
  assert.ok(Number.isFinite(result.precisionDelta)); assert.ok(Number.isFinite(result.trToEnDelta));
});
