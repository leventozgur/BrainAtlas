import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { initVault, parseFrontmatter, readPage, listPages, appendLog, upsertIndexEntry } from '../../../packages/core/src/vault/index.mjs';
import { checkPage, checkVault } from '../../../packages/core/src/okf/index.mjs';
import { checkpoint } from '../../../packages/core/src/checkpoint/index.mjs';

const asOf = new Date('2026-11-08T00:00:00Z');
const temp = async t => { const d = await mkdtemp(join(tmpdir(), 'c4-accept-')); t.after(() => rm(d, {recursive:true, force:true})); return d; };
const base = {type:'entity', generated:'2026-01-02', status:'proposed', sources:[], verified:[], stale_after:'P999D', aliases:[], keywords:[]};
const rules = (data, options={}) => checkPage({path:'wiki/entities/test.md', data, ...options}, {asOf}).map(x => x.rule);
const git = (dir, env, ...args) => spawnSync('git', args, {cwd:dir, env, encoding:'utf8'});
const runner = async (cmd, args, opts) => { const r = spawnSync(cmd, args, {cwd:opts.cwd, env:opts.env, encoding:'utf8'}); if (r.error) throw r.error; return {stdout:r.stdout, stderr:r.stderr, exitCode:r.status}; };
const cleanSafety = {scanPath:()=>[], scanText:()=>[]};
async function repo(t) { const d=await temp(t); const home=join(d,'home'); await mkdir(home); const global=join(d,'global'); await writeFile(global,'# sentinel\n'); const env={PATH:process.env.PATH, HOME:home, GIT_CONFIG_GLOBAL:global, GIT_CONFIG_NOSYSTEM:'1', LC_ALL:'C'}; assert.equal(git(d,env,'init','-q').status,0); await mkdir(join(d,'wiki')); return {d,env,global}; }

test('demo report matches every finding exactly', async () => {
  assert.deepEqual(await checkVault(resolve('demo-vault'), {asOf}), JSON.parse(await readFile('demo-vault/EXPECTED-OKF.json','utf8')));
});
test('frontmatter preserves unquoted dates and rejects malformed YAML', () => {
  for (const value of ['2026-01-02','2026-01-02T23:30:00+03:00']) { const p=parseFrontmatter(`---\ngenerated: ${value}\n---\nbody`); assert.equal(p.data.generated,value); assert.deepEqual(p.errors,[]); }
  for (const text of ['---\na: [\n---','---\na: 1\na: 2\n---','---\na: 1']) assert.ok(parseFrontmatter(text).errors.length);
  assert.equal(parseFrontmatter('plain').body,'plain');
});
test('OKF profile positive, negative, and boundary fixtures', () => {
  assert.deepEqual(rules(base),[]);
  for (const key of ['generated','status','sources','verified','stale_after']) { const d={...base}; delete d[key]; assert.ok(rules(d).includes(`required.${key}`)); }
  for (const [key,value,rule] of [['type','bad','type.invalid'],['status','bad','status.invalid'],['generated','2026-02-30','generated.invalid'],['generated','2027-01-01','generated.future'],['sources',[''],'sources.invalid'],['verified',[{date:'bad'}],'verified.invalid'],['stale_after','P0D','stale_after.invalid'],['aliases',null,'recommended.aliases'],['keywords',null,'recommended.keywords'],['status','confirmed','confirmed.unverified'],['status','superseded','superseded.target-required'],['superseded_by','wiki/x.md','superseded.target-unexpected']]) assert.ok(rules({...base,[key]:value}).includes(rule),rule);
  assert.ok(rules({...base,stale_after:'2026-11-07'}).includes('stale.expired'));
  assert.ok(!rules({...base,stale_after:'2026-11-08'}).includes('stale.expired'));
  assert.ok(!rules({...base,status:'superseded',superseded_by:'wiki/x.md'}).includes('superseded.target-required'));
  const raw='---\ngenerated: 2026-01-02\nstale_after: 2026-11-08\nverified:\n  - date: 2026-01-02\n---\nSECRET_BODY_MARKER';
  const found=checkPage({path:'wiki/entities/x.md',...parseFrontmatter(raw),raw},{asOf});
  for(const rule of ['date.unquoted.generated','date.unquoted.stale_after','date.unquoted.verified']) assert.ok(found.some(f=>f.rule===rule));
  assert.ok(!JSON.stringify(found).includes('SECRET_BODY_MARKER'));
  assert.ok(rules(base,{errors:[{code:'bad'}]}).includes('frontmatter.invalid'));
});
test('vault creation, append, index upsert and traversal', async t => {
  const d=await temp(t); await initVault(d); const file=join(d,'wiki/index.md'); const original=Buffer.from([0x23,0x20,0x78,0x0a,0xff]); await writeFile(file,original); await initVault(d); assert.deepEqual(await readFile(file),original);
  const log=join(d,'wiki/log.md'); const before=await readFile(log,'utf8'); await appendLog(d,{action:'update',path:'wiki/a.md',secret:'SECRET_BODY_MARKER'},{now:new Date('2026-01-01T00:00:00Z')}); const after=await readFile(log,'utf8'); assert.ok(after.startsWith(before)); assert.ok(!after.includes('SECRET_BODY_MARKER'));
  await upsertIndexEntry(d,{path:'wiki/a.md',title:'A'}); await upsertIndexEntry(d,{path:'wiki/a.md',title:'B'}); assert.equal((await readFile(file,'utf8')).split('(wiki/a.md)').length-1,1);
  await assert.rejects(readPage(d,'../x'),e=>e.code==='E_PATH_ESCAPE'); await assert.rejects(upsertIndexEntry(d,{path:'wiki/../x',title:'x'}),e=>e.code==='E_INDEX_ENTRY');
  await writeFile(join(d,'wiki/a.md'),'hello'); assert.equal((await readPage(d,'wiki/a.md')).body,'hello'); assert.ok((await listPages(d)).includes('wiki/a.md'));
});
test('readPage rejects a symlink escaping the vault', async t => {
  const d=await temp(t); await initVault(join(d,'vault')); await writeFile(join(d,'outside.md'),'PRIVATE_OUTSIDE'); await symlink(join(d,'outside.md'),join(d,'vault/wiki/link.md')); assert.ok(!(await listPages(join(d,'vault'))).includes('wiki/link.md')); await assert.rejects(readPage(join(d,'vault'),'wiki/link.md'),e=>e.code==='E_PATH_ESCAPE');
});
test('checkpoint skips unavailable git and non-repository', async t => {
  const d=await temp(t); const empty=join(d,'empty'); await mkdir(empty); const env={PATH:empty,HOME:join(d,'home'),GIT_CONFIG_GLOBAL:join(d,'global'),GIT_CONFIG_NOSYSTEM:'1'};
  assert.equal((await checkpoint(d,'test',{env,runCommand:runner})).skipped,true);
  assert.equal((await checkpoint(d,'test',{env:{...env,PATH:process.env.PATH},runCommand:runner})).skipped,true);
});
test('checkpoint scope, lint and global configuration', async t => {
  const {d,env,global}=await repo(t); await writeFile(join(d,'wiki/a.md'),'safe'); await writeFile(join(d,'outside.md'),'outside');
  await assert.rejects(checkpoint(d,'test',{env,runCommand:runner,lint:()=>false,safety:cleanSafety}),e=>e.code==='E_CHECKPOINT_LINT');
  const result=await checkpoint(d,'test',{env,runCommand:runner,lint:()=>true,safety:cleanSafety}); assert.equal(result.committed,true); assert.deepEqual(result.paths,['wiki/a.md']); assert.equal(git(d,env,'ls-tree','-r','--name-only','HEAD').stdout.trim(),'wiki/a.md'); assert.equal(await readFile(global,'utf8'),'# sentinel\n');
  await assert.rejects(checkpoint(d,'test',{paths:['../outside'],env,runCommand:runner}),e=>e.code==='E_CHECKPOINT_PATH');
});
test('checkpoint refuses staged secrets without revealing them', async t => {
  const {d,env}=await repo(t); const secret=['sk','test-1234567890abcdefghijklmnop'].join('-') /* PM: built at runtime so the repo privacy scan stays clean */; await writeFile(join(d,'wiki/a.md'),`api_key=${secret}\n`); assert.equal(git(d,env,'add','wiki/a.md').status,0);
  let error; try { await checkpoint(d,'test',{env,runCommand:runner,lint:()=>true}); } catch(e) { error=e; }
  assert.ok(error); assert.ok(!String(error.stack).includes(secret)); assert.notEqual(git(d,env,'rev-parse','--verify','HEAD').status,0); assert.equal(error.code,'E_SECRET_DETECTED');
});
test('template and demo text has no personal paths, emails or hostnames', async () => {
  async function walk(dir) { for(const e of await readdir(dir,{withFileTypes:true})) { const p=join(dir,e.name); if(e.isDirectory()) await walk(p); else if(e.isFile()) { const s=await readFile(p,'utf8'); assert.doesNotMatch(s,/(?:\/Users\/|\/home\/|[A-Z]:\\Users\\)[^\s]*/i,p); assert.doesNotMatch(s,/[\w.+-]+@[\w.-]+\.[a-z]{2,}/i,p); assert.doesNotMatch(s,/\b(?:https?:\/\/|localhost\b|(?:[a-z0-9-]+\.)+(?:com|org|net|io|local)\b)/i,p); } } }
  await walk('templates'); await walk('demo-vault');
});
test('injected secret scanner blocks staged content without exposing its value', async t => {
  const {d,env}=await repo(t); const secret='SECRET_FIXTURE_89217'; await writeFile(join(d,'wiki/a.md'),secret); const safety={scanPath:()=>[],scanText:s=>s.includes(secret)?[{rule:'secret'}]:[]};
  await assert.rejects(checkpoint(d,'test',{env,runCommand:runner,lint:()=>true,safety}),e=>e.code==='E_SECRET_DETECTED'&&!String(e.stack).includes(secret)); assert.notEqual(git(d,env,'rev-parse','--verify','HEAD').status,0);
});
test('log helper must not write through a symlink outside vault', async t => {
  const d=await temp(t); const vault=join(d,'vault'); await initVault(vault); const outside=join(d,'outside'); await writeFile(outside,'OUTSIDE\n'); await rm(join(vault,'wiki/log.md')); await symlink(outside,join(vault,'wiki/log.md'));
  try { await appendLog(vault,{action:'update'},{now:new Date('2026-01-01T00:00:00Z')}); } catch {} assert.equal(await readFile(outside,'utf8'),'OUTSIDE\n');
});
test('full and changed scans handle missing targets and unreadable pages', async t => {
  const d=await temp(t); await initVault(d); const metadata={...base,status:'superseded',superseded_by:'wiki/entities/target.md'}; const yaml=Object.entries(metadata).map(([k,v])=>`${k}: ${JSON.stringify(v)}`).join('\n'); await writeFile(join(d,'wiki/entities/a.md'),`---\n${yaml}\n---\n`);
  assert.ok((await checkVault(d,{asOf})).some(f=>f.rule==='superseded.target-missing')); await writeFile(join(d,'wiki/entities/target.md'),`---\n${yaml.replace('superseded','proposed').replace('superseded_by: "wiki/entities/target.md"','')}\n---\n`); assert.ok(!(await checkVault(d,{asOf})).some(f=>f.rule==='superseded.target-missing'));
  const changed=await checkVault(d,{asOf,changed:['wiki/entities/missing.md','../outside.md']}); assert.deepEqual(changed.map(f=>f.rule),['page.unreadable']);
});
