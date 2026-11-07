// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { buildIndex, search, createSearcher, loadPages } from '../../../packages/core/src/retrieval/index.mjs';
import { runEval } from '../../../eval/run-eval.mjs';
const now = new Date('2025-01-01T00:00:00Z');
const page = (name, body, frontmatter = {}) => ({path:name,title:'Backup',aliases:[],keywords:[],headings:[],body,frontmatter});
function temp(t) { const dir=fs.mkdtempSync(path.join(os.tmpdir(),'retrieval-test-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true})); return dir; }
test('ranking, freshness, supersession, budget, threshold and empty queries', () => {
  const index=buildIndex([page('b.md','backup contents',{stale_after:'P7D',generated:'2020-01-01'}),page('a.md','backup contents'),page('old.md','backup',{status:'superseded'}),page('old2.md','backup',{superseded_by:'a.md'})],{now});
  const r=search(index,'backup',{budgetChars:4});
  assert.deepEqual(r.results.map(x=>x.path),['a.md','b.md']); assert.equal(r.results[1].stale,true); assert.equal(r.truncated,true); assert.equal(r.results.map(x=>x.snippet).join('').length,4); assert.ok(r.results[0].snippet.endsWith('…'));
  assert.equal(search(index,'unmatched').abstained,true); assert.equal(search(index,'backup unmatched',{abstainThreshold:0.99}).abstained,true);
  assert.throws(()=>search(index,'the ve'),{code:'E_QUERY_EMPTY'});
});
test('loader, cache invalidation and corrupt cache recovery', async t => {
  const dir=temp(t), vault=path.join(dir,'vault'), state=path.join(dir,'state'); fs.mkdirSync(vault);
  const file=path.join(vault,'x.md'); fs.writeFileSync(file,'---\ntitle: Alpha\ngenerated: 2020-01-01\nstale_after: P1W\n---\n# Alpha\nalpha body');
  assert.equal(loadPages(vault)[0].frontmatter.generated,'2020-01-01');
  const s=createSearcher({vaultDir:vault,stateDir:state,now}); assert.equal(s.search('alpha').results[0].stale,true);
  fs.writeFileSync(file,'---\ntitle: Bravo\n---\n# Bravo\nbravo body'); await s.refresh(); assert.equal(s.search('bravo').results[0].title,'Bravo');
  fs.writeFileSync(path.join(state,'retrieval-index.json'),'{'); const recovered=createSearcher({vaultDir:vault,stateDir:state,now}); assert.equal(recovered.search('bravo').results.length,1);
});
test('dev eval and excluded superseded pages', () => {
  const corpusDir='eval/corpus',casesFile='eval/dev/cases.json'; const result=runEval({corpusDir,casesFile,now}); assert.ok(result.n>=40); assert.ok(result.recallAt5>=0.8); assert.equal(result.abstainAccuracy,1); assert.equal(result.trToEnRecallAt5,1);
  const index=buildIndex(loadPages(corpusDir),{now}); const cases=JSON.parse(fs.readFileSync(casesFile)); for (const c of cases.filter(c=>c.excluded)) assert.ok(search(index,c.query).results.every(r=>!c.excluded.includes(r.path)));
});
test('warm query median on 2000-page vault is under 300 ms', t => {
  const dir=temp(t),vault=path.join(dir,'vault'),state=path.join(dir,'state'); fs.mkdirSync(vault);
  for(let i=0;i<2000;i++) fs.writeFileSync(path.join(vault,`${i}.md`),`---\ntitle: Topic ${i}\n---\n# Topic ${i}\nSynthetic common content ${i}.`);
  const searcher=createSearcher({vaultDir:vault,stateDir:state,now}); const timings=[];
  for(let i=0;i<5;i++){const start=performance.now(); searcher.search('topic 1234'); timings.push(performance.now()-start);}
  timings.sort((a,b)=>a-b); t.diagnostic(`Warm query median: ${timings[2].toFixed(2)} ms`); assert.ok(timings[2]<300,`median ${timings[2]} ms`);
});
