// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { buildIndex, search, createSearcher, loadPages, stem } from '../../../packages/core/src/retrieval/index.mjs';
import { runEval } from '../../../eval/run-eval.mjs';
import { atomicWriteFileSync } from '../../../packages/core/src/util/index.mjs';
const now = new Date('2025-01-01T00:00:00Z');
const page = (name, body, frontmatter = {}) => ({path:name,title:'Backup',aliases:[],keywords:[],headings:[],body,frontmatter});
test('unsafe paths and stacked suffixes are handled consistently', () => {
  const index = buildIndex([page('../escape.md', 'canary'), page('/absolute.md', 'canary'), page('folder\\escape.md', 'canary'), page('safe.md', 'yedek')], {now});
  assert.deepEqual(search(index, 'canary').results, []);
  assert.equal(search(index, 'yedeklerden').results[0].path, 'safe.md');
  assert.equal(stem('stories'), 'story');
  assert.equal(stem('kisa'), 'kisa');
  assert.throws(() => search(index, 42), {code:'E_QUERY_INVALID'});
});
test('eval records a malformed query as a failure and continues', t => {
  const dir = temp(t), vault = path.join(dir, 'vault'); fs.mkdirSync(vault);
  fs.writeFileSync(path.join(vault, 'a.md'), '# Alpha\nalpha evidence');
  const casesFile = path.join(dir, 'cases.json');
  fs.writeFileSync(casesFile, JSON.stringify([{query:42,relevant:['a.md']},{query:'alpha',relevant:['a.md']}]));
  const result = runEval({corpusDir:vault,casesFile,now});
  assert.equal(result.n, 2); assert.equal(result.recallAt5, 0.5);
});
function temp(t) { const dir=fs.mkdtempSync(path.join(os.tmpdir(),'retrieval-test-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true})); return dir; }
test('ranking, freshness, supersession, budget, threshold and empty queries', () => {
  const index=buildIndex([page('b.md','backup contents',{stale_after:'P7D',generated:'2020-01-01'}),page('a.md','backup contents'),page('old.md','backup',{status:'superseded'}),page('old2.md','backup',{superseded_by:'a.md'})],{now});
  const r=search(index,'backup',{budgetChars:4});
  assert.deepEqual(r.results.map(x=>x.path),['a.md','b.md']); assert.equal(r.results[1].stale,true); assert.equal(r.truncated,true); assert.equal(r.results.map(x=>x.snippet).join('').length,4); assert.ok(r.results[0].snippet.endsWith('…'));
  assert.equal(search(index,'unmatched').abstained,true); assert.equal(search(index,'backup unmatched',{abstainThreshold:0.99}).abstained,true);
  assert.equal(search(index,'the ve').reason,'empty-query');
});
test('calibrated confidence retains unmatched-term penalties and threshold boundaries', () => {
  const index = buildIndex([page('a.md', 'backup archive'), page('b.md', 'archive')], {now});
  const strong = search(index, 'backup archive');
  const weak = search(index, 'backup archive unknown unrelated');
  assert.deepEqual(weak.results.map(r => r.path), strong.results.map(r => r.path));
  assert.ok(weak.results[0].score < strong.results[0].score);
  assert.ok(weak.results.every(r => r.score >= 0 && r.score <= 1));
  const threshold = weak.results[0].score;
  assert.equal(search(index, 'backup archive unknown unrelated', {abstainThreshold: threshold}).abstained, false);
  assert.equal(search(index, 'backup archive unknown unrelated', {abstainThreshold: threshold + 1e-9}).abstained, true);
  assert.equal(search(index, 'unknown unrelated', {abstainThreshold: 0.35}).abstained, true);
});
test('section selection uses distinct weighted stems, ancestry, and the snippet budget', () => {
  const index = buildIndex([page('a.md', '# Root\ncommon common\n## First\ncommon\n## Second\nrare common evidence\n### Child\nother') , page('b.md', 'common')], {now});
  const result = search(index, 'common rare', {limit:1}).results[0];
  assert.equal(result.heading, 'Second'); assert.equal(result.headingPath, 'Root > Second');
  assert.equal(result.anchor, 'second'); assert.equal(result.snippet, 'rare common evidence');
  const bounded = search(index, 'common rare', {limit:1, budgetChars:5});
  assert.equal(bounded.results[0].snippet, 'rare…'); assert.equal(bounded.truncated, true);
  assert.equal(search(index, 'common').results.find(result => result.path === 'a.md').heading, 'Root');
});
test('fences, duplicate headings, collisions, and Turkish anchor folding', () => {
  const body = '# İLK\nordinary\n```js\n# comment\n```\n## Işık\nfirst\n## Işık\nsecondtarget\n## Isik-1\nthirdtarget\n## Işık\nfourthtarget';
  const index = buildIndex([page('a.md', body)], {now});
  const second = search(index, 'secondtarget').results[0];
  assert.equal(second.heading, 'Işık'); assert.equal(second.anchor, 'isik-1'); assert.equal(second.headingPath, 'İLK > Işık');
  assert.equal(search(index, 'thirdtarget').results[0].anchor, 'isik-1-1');
  assert.equal(search(index, 'fourthtarget').results[0].anchor, 'isik-2');
  const comment = search(index, 'comment').results[0];
  assert.equal(comment.heading, 'İLK'); assert.match(comment.snippet, /# comment/);
});
test('headingless and section-unmatched pages retain the body snippet', () => {
  const plain = search(buildIndex([page('a.md', 'plain evidence')], {now}), 'plain').results[0];
  assert.equal(plain.snippet, 'plain evidence'); assert.equal(plain.heading, null); assert.equal(plain.anchor, null); assert.equal(plain.headingPath, null);
  const body = 'preface\n# Title\nunrelated';
  const unmatched = search(buildIndex([page('b.md', body)], {now}), 'backup').results[0];
  assert.equal(unmatched.snippet, body); assert.equal(unmatched.heading, null);
});
test('synthetic snippet coverage compares body-start and selected sections', () => {
  const pages = [page('a.md', '# Intro\nfiller\n## Detail\norchards thrive'), page('b.md', '# Intro\nfiller\n## Detail\nharbors thrive')];
  const index = buildIndex(pages, {now});
  const queries = ['orchards', 'harbors'];
  const contains = (text, query) => new Set((text.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).map(stem)).has(stem(query));
  let before = 0, after = 0;
  for (const query of queries) {
    const result = search(index, query, {limit:1, budgetChars:20}).results[0];
    before += Number(contains(pages.find(p => p.path === result.path).body.trim().slice(0, 19) + '…', query));
    after += Number(contains(result.snippet, query));
  }
  assert.equal(before, 0); assert.equal(after, queries.length);
});
test('loader, cache invalidation and corrupt cache recovery', async t => {
  const dir=temp(t), vault=path.join(dir,'vault'), state=path.join(dir,'state'); fs.mkdirSync(vault);
  const file=path.join(vault,'x.md'); fs.writeFileSync(file,'---\ntitle: Alpha\ngenerated: 2020-01-01\nstale_after: P1W\n---\n# Alpha\nalpha body');
  assert.equal(loadPages(vault)[0].frontmatter.generated,'2020-01-01');
  const s=createSearcher({vaultDir:vault,stateDir:state,now}); assert.equal(s.search('alpha').results[0].stale,true);
  fs.writeFileSync(file,'---\ntitle: Bravo\n---\n# Bravo\nbravo body'); await s.refresh(); assert.equal(s.search('bravo').results[0].title,'Bravo');
  fs.writeFileSync(path.join(state,'retrieval-index.json'),'{'); const recovered=createSearcher({vaultDir:vault,stateDir:state,now}); assert.equal(recovered.search('bravo').results.length,1);
});
test('retrieval cache rename failure preserves the previous cache and cleans its temporary file', async t => {
  const dir=temp(t), vault=path.join(dir,'vault'), state=path.join(dir,'state'); fs.mkdirSync(vault);
  fs.writeFileSync(path.join(vault,'x.md'),'# Alpha\nalpha body'); fs.mkdirSync(state);
  const cache=path.join(state,'retrieval-index.json'); fs.writeFileSync(cache,'old cache');
  const fsOps={...await import('node:fs'), renameSync: () => { throw new Error('injected rename failure'); }};
  const atomicWriter=(file,data,options)=>atomicWriteFileSync(file,data,{...options,fsSyncOps:fsOps});
  const s=createSearcher({vaultDir:vault,stateDir:state,now,atomicWriter}); await s.refresh();
  assert.equal(fs.readFileSync(cache,'utf8'),'old cache');
  assert.deepEqual(fs.readdirSync(state),['retrieval-index.json']);
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
