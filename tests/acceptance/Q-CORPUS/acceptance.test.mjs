import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, lstatSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';
import { scanText } from '../../../packages/core/src/safety/index.mjs';
const root = resolve(new URL('../../..', import.meta.url).pathname);
const dir = join(root,'eval/corpus-natural');
const files = readdirSync(dir).filter(x=>x.endsWith('.md')).sort();
const pages = new Map(files.map(x=>[x,readFileSync(join(dir,x),'utf8')]));
const cases = JSON.parse(readFileSync(join(root,'eval/dev/natural-cases.json'),'utf8'));
const words = x => x.toLocaleLowerCase('tr').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').match(/[\p{L}\p{N}_]+/gu) ?? [];
const fm = s => {const m=s.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/); if(!m) throw Error('frontmatter'); const v=parse(m[1]); if(!v || typeof v!=='object' || Array.isArray(v)) throw Error('mapping'); return v};
const isSafeName = s => typeof s==='string' && s!=='.' && s!=='..' && basename(s)===s && !s.includes('\\');
const hasCopy = (q,p) => {const a=words(q), b=words(p).join(' '); return a.some((_,i)=>i+6<=a.length && (` ${b} `).includes(` ${a.slice(i,i+6).join(' ')} `))};
const sentences = s => s.split(/\n\s*\n/).flatMap(p=>p.replace(/\n/g,' ').split(/(?<=[.!?])\s+/)).map(s=>s.trim()).filter(s=>words(s).length>=12);
const targets={tr:20,en:20,mixed:12,synonym:10,'technical-exact':12,typo:8,'near-miss':8,'stale-superseded':5,'no-answer':5};

test('validator boundaries and malformed inputs',()=>{
 assert.equal(hasCopy('one two three four five','one two three four five six'),false); assert.equal(hasCopy('one two three four five six','zero one two three four five six seven'),true);
 assert.equal(isSafeName('../outside.md'),false); assert.equal(isSafeName('..\\outside.md'),false); assert.equal(isSafeName('safe.md'),true);
 assert.throws(()=>fm('---\na: [\n---\n')); assert.throws(()=>fm('no frontmatter')); assert.equal(fm('---\ntitle: ok\n---\n').title,'ok');
 const secret=['sk','test'+'x'.repeat(24)].join('-'); assert.ok(scanText(secret).length); assert.equal(scanText('ordinary documentation').length,0);
});
test('corpus pages, metadata, freshness, paths, privacy and lengths',()=>{
 assert.equal(files.length,60); let stale=0, superseded=0; const statuses=new Set();
 for(const [name,s] of pages){ assert.ok(lstatSync(join(dir,name)).isFile(),name); const f=fm(s); statuses.add(f.status); assert.ok(typeof f.title==='string'&&f.title.trim(),name); assert.ok(['active','superseded','disputed','confirmed'].includes(f.status),name); for(const k of ['generated','stale_after']) assert.ok(/^\d{4}-\d\d-\d\d$/.test(String(f[k])) && Number.isFinite(Date.parse(f[k])),`${name} ${k}`); if(Date.parse(f.stale_after)<Date.parse('2026-11-08T00:00:00Z')) stale++; if(f.status==='superseded'){superseded++;assert.ok(isSafeName(f.superseded_by)&&pages.has(f.superseded_by),name)} assert.ok((s.match(/^## /gm)||[]).length>=2,name); assert.match(s,/```[\s\S]*?```/,name); const n=words(s).length; assert.ok(n>=150&&n<=500,`${name}: ${n}`); assert.deepEqual(scanText(s),[],name); assert.doesNotMatch(s,/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|(?:\/Users\/|\/home\/)[^\s]+|\b(?:\d{1,3}\.){3}\d{1,3}\b/i,name); }
 assert.ok(stale>=10); assert.ok(superseded>=5); for(const s of ['active','superseded','disputed','confirmed']) assert.ok(statuses.has(s),s);
});
test('cases: identifiers, counts, references and category semantics',()=>{
 assert.equal(cases.length,100); const ids=new Set(), counts={}; for(const c of cases){assert.ok(typeof c.id==='string'&&c.id&&!ids.has(c.id),c.id);ids.add(c.id);assert.ok(typeof c.query==='string'&&c.query.trim());assert.ok(Object.hasOwn(targets,c.category));counts[c.category]=(counts[c.category]||0)+1;assert.ok(Array.isArray(c.relevant)); if(c.excluded!==undefined) assert.ok(Array.isArray(c.excluded)); for(const p of [...c.relevant,...(c.excluded||[])]) assert.ok(isSafeName(p)&&pages.has(p),`${c.id}: ${p}`); if(c.category==='no-answer'){assert.equal(c.abstain,true);assert.equal(c.relevant.length,0)}else assert.ok(c.relevant.length); if(c.category==='near-miss'||c.category==='stale-superseded') assert.ok(c.excluded?.length,c.id); if(c.category==='stale-superseded') for(const p of c.excluded) assert.equal(fm(pages.get(p)).status,'superseded',c.id); }
 for(const [k,v] of Object.entries(targets)) assert.ok(Math.abs((counts[k]||0)-v)<=2,`${k}: ${counts[k]}`);
});
test('no query copies six consecutive words from any page',()=>{for(const c of cases) for(const [n,p] of pages) assert.equal(hasCopy(c.query,p),false,`${c.id} ${n}`)});
test('pages do not repeat sentence openings of twelve words',()=>{const seen=new Map(), duplicates=[];for(const [n,p] of pages) for(const s of sentences(p)){const k=words(s).slice(0,12).join(' '); if(seen.has(k)&&seen.get(k)!==n) duplicates.push(`${seen.get(k)} / ${n}: ${k}`); else seen.set(k,n)} assert.deepEqual(duplicates.slice(0,5),[], `${duplicates.length} repeated sentence openings`)});
test('runner handles fixtures without touching HOME or leaking a synthetic secret',()=>{const temp=mkdtempSync(join(tmpdir(),'qcorpus-'));try{const home=join(temp,'home');mkdirSync(home);const corpus=join(temp,'pages');mkdirSync(corpus);writeFileSync(join(corpus,'one.md'),'---\ntitle: Sample\nstatus: active\n---\n# Sample\n\nA plain searchable example.\n');const secret=['sk','test'+'x'.repeat(24)].join('-');const f=join(temp,'cases.json');writeFileSync(f,JSON.stringify([{id:'case-1',query:secret,relevant:['one.md']} ]));const run=spawnSync(process.execPath,[join(root,'eval/run-eval.mjs'),'--corpus',corpus,'--cases',f,'--verbose','--now','2026-11-08'],{cwd:temp,env:{...process.env,HOME:home,XDG_CONFIG_HOME:home},encoding:'utf8'});assert.equal(run.status,0,run.stderr);assert.ok(!`${run.stdout}${run.stderr}`.includes(secret));assert.deepEqual(readdirSync(home),[]);const bad=join(temp,'bad.json');writeFileSync(bad,'{');const err=spawnSync(process.execPath,[join(root,'eval/run-eval.mjs'),'--corpus',corpus,'--cases',bad],{cwd:temp,env:{...process.env,HOME:home},encoding:'utf8'});assert.notEqual(err.status,0);assert.deepEqual(readdirSync(home),[])}finally{rmSync(temp,{recursive:true,force:true})}});

test('loader ignores symlinks to files outside the corpus', async()=>{
 const {loadPages}=await import('../../../packages/core/src/retrieval/index.mjs'); const {symlinkSync}=await import('node:fs'); const t=mkdtempSync(join(tmpdir(),'qcorpus-link-')); try {const d=join(t,'corpus'); mkdirSync(d); writeFileSync(join(d,'inside.md'),'---\ntitle: Inside\n---\n# Inside\n'); writeFileSync(join(t,'outside.md'),'---\ntitle: Outside\n---\n# Outside\n'); symlinkSync(join(t,'outside.md'),join(d,'escape.md')); assert.deepEqual(loadPages(d).map(x=>x.path),['inside.md']);} finally {rmSync(t,{recursive:true,force:true})}
});
test('labeled evidence answers the two unambiguous near-miss queries',()=>{
 const first=cases.find(c=>c.id==='near-miss-01'); const fourth=cases.find(c=>c.id==='near-miss-04');
 assert.match(pages.get(first.relevant[0]),/\b(?:pid|process identifier)\b/i,'near-miss-01 must explain process identifiers');
 assert.match(pages.get(fourth.relevant[0]),/\bstatus\b/i,'near-miss-04 must discuss status');
});
