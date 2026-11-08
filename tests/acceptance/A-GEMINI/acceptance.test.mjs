import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile, rm, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as a from '../../../packages/adapters/gemini-cli/src/index.mjs';

async function setup(t, scope='global', platform='linux') {
  const base=await mkdtemp(join(tmpdir(),'gemini-accept-')); t.after(()=>rm(base,{recursive:true,force:true}));
  const home=join(base,'fake home'), vault=join(base,'vault'), sentinel=join(base,'outside-sentinel');
  await mkdir(home,{recursive:true}); await mkdir(vault,{recursive:true}); await writeFile(sentinel,'untouched');
  const ctx={env:{HOME:home,XDG_STATE_HOME:join(base,'state')},platform,scope,vaultDir:vault,nodePath:'/absolute node/bin/node',shimPath:'/stable shim/brainatlas',now:new Date('2026-01-02T03:04:05Z')};
  const root=scope==='vault'?vault:home;
  return {base,home,vault,sentinel,ctx,json:join(root,'.gemini','settings.json'),md:join(root,'GEMINI.md')};
}
const read = p=>readFile(p,'utf8').catch(e=>{if(e.code==='ENOENT')return null;throw e});
async function put(p,s){await mkdir(join(p,'..'),{recursive:true});await writeFile(p,s)}
const code = c => e=>e.code===c;
for(const scope of ['global','vault']) for(const platform of ['linux','darwin']) for(const [name,json,md] of [
 ['missing',null,null],['empty files','', ''],['two spaces','{\n  "theme": "dark",\n  "mcpServers": {"other": {"command": "keep"}}\n}\n','# User\n'],
 ['four spaces','{\n    "theme": "dark"\n}','user text'],['tabs','{\n\t"theme": "dark"\n}\n','user\r\n'],
 ['existing entry',' { "mcpServers": { "brainatlas": {"command":"old"}, "other": {} } }','existing']
]) test(`${scope}/${platform}: round trip ${name}`,async t=>{
 const x=await setup(t,scope,platform); if(json!==null)await put(x.json,json); if(md!==null)await put(x.md,md);
 const p=a.plan(x.ctx); await a.apply(p,x.ctx); const applied=await read(x.json); const obj=JSON.parse(applied);
 assert.deepEqual(obj.mcpServers.brainatlas,{command:x.ctx.nodePath,args:[x.ctx.shimPath,'mcp']});
 if(json && JSON.parse(json).theme) assert.equal(obj.theme,'dark');
 assert.match(await read(x.md),/pull mode/); assert.equal(a.plan(x.ctx).changes.length,0);
 await a.remove(x.ctx); assert.equal(await read(x.json),json); assert.equal(await read(x.md),md); assert.equal(await read(x.sentinel),'untouched');
 if(scope==='vault') assert.equal(await read(join(x.home,'GEMINI.md')),null);
});
for(const [label,content,expected] of [['malformed','{bad','E_CONFIG_PARSE'],['BOM','\ufeff{}','E_BOM']]) test(`${label} leaves both files untouched`,async t=>{
 const x=await setup(t); await put(x.json,content); await put(x.md,'user'); assert.throws(()=>a.plan(x.ctx),code(expected));
 assert.equal(await read(x.json),content); assert.equal(await read(x.md),'user'); await assert.rejects(a.remove(x.ctx),code(expected)); assert.equal(await read(x.md),'user');
});
test('edited managed block aborts remove without modifying either target',async t=>{
 const x=await setup(t); await a.apply(a.plan(x.ctx),x.ctx); const json=await read(x.json); const md=(await read(x.md)).replace('pull mode','modified'); await put(x.md,md);
 await assert.rejects(a.remove(x.ctx),code('E_MANAGED_BLOCK_EDITED')); assert.equal(await read(x.json),json); assert.equal(await read(x.md),md);
 assert.throws(()=>a.plan(x.ctx),code('E_MANAGED_BLOCK_EDITED'));
});
test('concurrent edit rejects apply without changing either target',async t=>{
 const x=await setup(t); const p=a.plan(x.ctx); await put(x.md,'concurrent'); await assert.rejects(a.apply(p,x.ctx),code('E_CONFIG_CHANGED')); assert.equal(await read(x.json),null); assert.equal(await read(x.md),'concurrent');
});
test('foreign and traversal plan targets are rejected before writes',async t=>{
 const x=await setup(t); const p=a.plan(x.ctx); p.changes.push({file:join(x.base,'escape'),before:null,after:'bad',kind:'create'});
 await assert.rejects(a.apply(p,x.ctx),code('E_PLAN_TARGET')); assert.equal(await read(x.json),null); assert.equal(await read(join(x.base,'escape')),null);
});
for(const vaultDir of ['relative','/tmp/one/../two']) test(`vault path rejected: ${vaultDir}`,async t=>{
 const x=await setup(t,'vault'); x.ctx.vaultDir=vaultDir; assert.throws(()=>a.plan(x.ctx),code('E_PATH_ESCAPE')); await assert.rejects(a.remove(x.ctx),code('E_PATH_ESCAPE'));
});
test('file symlink does not alter outside target',async t=>{
 const x=await setup(t); await mkdir(join(x.home,'.gemini'),{recursive:true}); await symlink(x.sentinel,x.json); const before=await read(x.sentinel);
 try {await a.apply(a.plan(x.ctx),x.ctx)} catch {} assert.equal(await read(x.sentinel),before);
});
test('doctor, detection and trust review distinguish states and identify Gemini',async t=>{
 const x=await setup(t); assert.equal(a.detect({HOME:x.home}),false); assert.equal(a.detect({HOME:x.home,GEMINI_CLI:'1'}),true);
 let d=await a.doctor(x.ctx); assert.equal(d.checks.find(c=>c.id==='registered').ok,false);
 await a.apply(a.plan(x.ctx),x.ctx); d=await a.doctor(x.ctx); assert.equal(d.checks.find(c=>c.id==='registered').ok,true);
 const review=await a.trustReview(x.ctx); assert.equal(review.client,'Gemini CLI'); assert.equal(review.required,true); assert.match(review.steps.join(' '),/Gemini CLI/);
 await a.remove(x.ctx); assert.equal((await a.doctor(x.ctx)).checks.find(c=>c.id==='registered').ok,false);
});
test('synthetic secret in user settings is preserved and absent from diagnostics',async t=>{
 const x=await setup(t); const secret=['sk','test'+'x'.repeat(24)].join('-'); await put(x.json,JSON.stringify({token:secret}));
 const p=a.plan(x.ctx); await a.apply(p,x.ctx); const diagnostics=JSON.stringify([await a.doctor(x.ctx),await a.trustReview(x.ctx)]); assert.equal(diagnostics.includes(secret),false); await a.remove(x.ctx); assert.equal(JSON.parse(await read(x.json)).token,secret);
});
test.skip('symlinked config directory is user-directed and allowed by PM policy');
