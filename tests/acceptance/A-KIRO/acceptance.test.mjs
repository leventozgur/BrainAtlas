// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import * as kiro from '../../../packages/adapters/kiro/src/index.mjs';

async function setup(t, scope='global', platform='linux') {
  const root=await mkdtemp(join(tmpdir(),'accept-kiro-')); t.after(()=>rm(root,{recursive:true,force:true}));
  const home=join(root,platform==='darwin'?'Users/test user':'home/test user'), vault=join(root,'vault');
  await mkdir(home,{recursive:true}); await mkdir(vault,{recursive:true});
  const sentinel=join(root,'outside-home-sentinel'); await writeFile(sentinel,'untouched');
  const ctx={env:{HOME:home,BRAINATLAS_PLATFORM:platform},platform,scope,vaultDir:vault,config:{vault:{path:vault}},paths:{stateDir:join(root,'state')},nodePath:process.execPath,shimPath:join(root,'stable shim','brainatlas'),now:new Date('2026-01-01T00:00:00Z')};
  const base=scope==='global'?home:vault;
  return {root,home,vault,ctx,sentinel,mcp:join(base,'.kiro/settings/mcp.json'),hook:join(base,'.kiro/hooks/brainatlas.json'),steering:join(base,'.kiro/steering/brainatlas.md')};
}
async function put(file,data) { await mkdir(dirname(file),{recursive:true}); await writeFile(file,data); }
async function get(file) { try {return await readFile(file,'utf8');} catch(e) {if(e.code==='ENOENT') return null; throw e;} }
const code = expected => e => e.code===expected;

for (const scope of ['global','vault']) for (const platform of ['linux','darwin']) {
  test(`${scope}/${platform}: absent files, idempotence, isolation and health`,async t=>{
    const f=await setup(t,scope,platform); await put(f.ctx.shimPath,'shim');
    assert.equal(kiro.detect({HOME:f.home}),true); assert.equal(kiro.detect({}),false);
    assert.equal((await kiro.doctor(f.ctx)).checks.find(c=>c.id==='registered').ok,false);
    const p=await kiro.plan(f.ctx); assert.equal(p.changes.length,3); assert.equal(await get(f.mcp),null);
    await kiro.apply(p,f.ctx); assert.equal((await kiro.plan(f.ctx)).changes.length,0);
    const health=await kiro.doctor(f.ctx); assert.equal(health.checks.find(c=>c.id==='registered').ok,true); assert.equal(health.checks.find(c=>c.id==='hook').ok,true); assert.equal(health.checks.find(c=>c.id==='trigger-verified').warning,true); // PM hotfix: warning, not a failing check
    const review=await kiro.trustReview(f.ctx); assert.equal(review.client,'Kiro'); assert.equal(review.required,true); assert.match(review.steps.join(' '),/Kiro/); assert.match(review.steps.join(' '),/hook/i);
    await kiro.remove(f.ctx); for(const file of [f.mcp,f.hook,f.steering]) assert.equal(await get(file),null); assert.equal(await get(f.sentinel),'untouched');
  });
}
for (const target of ['mcp','hook']) for (const indent of ['  ','    ','\t']) for (const newline of ['', '\n']) {
  test(`${target}: preserves populated JSON (${JSON.stringify(indent)}, newline=${!!newline})`,async t=>{
    const f=await setup(t); const obj=target==='mcp'?{user:{theme:'dark'},mcpServers:{other:{command:'user'}}}:{version:'v1',hooks:[{name:'user',action:{type:'command',command:'echo user'}}],user:true};
    const before=JSON.stringify(obj,null,indent)+newline; await put(f[target],before);
    await kiro.apply(await kiro.plan(f.ctx),f.ctx);
    const current=JSON.parse(await get(f[target])); if(target==='mcp') assert.deepEqual(current.user,obj.user); else assert.deepEqual(current.hooks[0],obj.hooks[0]);
    assert.equal((await kiro.plan(f.ctx)).changes.length,0); await kiro.remove(f.ctx); assert.equal(await get(f[target]),before);
  });
}
for (const target of ['mcp','hook']) for (const [name,raw,expected] of [['empty','','E_CONFIG_PARSE'],['broken','{"broken":','E_CONFIG_PARSE'],['bom','\uFEFF{}','E_BOM'],['array','[]','E_CONFIG_PARSE']]) {
  test(`${target}: ${name} input fails without writes`,async t=>{
    const f=await setup(t); await put(f[target],raw); await assert.rejects(kiro.plan(f.ctx),code(expected)); assert.equal(await get(f[target]),raw); assert.equal(await get(f.sentinel),'untouched');
  });
}
test('existing empty hooks configuration survives apply/remove byte for byte',async t=>{
  const f=await setup(t), before='{ "version": "v1", "hooks": [] }\n'; await put(f.hook,before);
  await kiro.apply(await kiro.plan(f.ctx),f.ctx); await kiro.remove(f.ctx); assert.equal(await get(f.hook),before);
});
test('existing empty MCP configuration survives apply/remove byte for byte',async t=>{
  const f=await setup(t), before='{ }\n'; await put(f.mcp,before);
  await kiro.apply(await kiro.plan(f.ctx),f.ctx); await kiro.remove(f.ctx); assert.equal(await get(f.mcp),before);
});
test('existing brainatlas registration is restored after remove',async t=>{
  const f=await setup(t), before='{"mcpServers":{"brainatlas":{"command":"user-server"}}}\n'; await put(f.mcp,before);
  await kiro.apply(await kiro.plan(f.ctx),f.ctx); await kiro.remove(f.ctx); assert.equal(await get(f.mcp),before);
});
test('managed steering edits are rejected and concurrent changes prevent every write',async t=>{
  const f=await setup(t); await kiro.apply(await kiro.plan(f.ctx),f.ctx); const changed=(await get(f.steering)).replace('Prefer wiki_query','User edit'); await put(f.steering,changed);
  await assert.rejects(kiro.plan(f.ctx),code('E_MANAGED_BLOCK_EDITED')); await assert.rejects(kiro.remove(f.ctx),code('E_MANAGED_BLOCK_EDITED')); assert.equal(await get(f.steering),changed);
});
test('stale plan refuses all writes',async t=>{
  const f=await setup(t), p=await kiro.plan(f.ctx); await put(f.mcp,'{}'); await assert.rejects(kiro.apply(p,f.ctx),code('E_CONFIG_CHANGED')); assert.equal(await get(f.mcp),'{}'); assert.equal(await get(f.hook),null); assert.equal(await get(f.steering),null);
});
test('MCP read-only approval and stable absolute paths; hook invokes fail-open hook bin',async t=>{
  const f=await setup(t), p=await kiro.plan(f.ctx); const m=JSON.parse(p.changes.find(c=>c.file===f.mcp).after).mcpServers.brainatlas; const h=JSON.parse(p.changes.find(c=>c.file===f.hook).after).hooks[0];
  assert.equal(m.command,f.ctx.nodePath); assert.deepEqual(m.args,[f.ctx.shimPath,'mcp']); assert.deepEqual(m.autoApprove,['wiki_query','wiki_read_page','wiki_read_index','wiki_list_pages','wiki_status']);
  assert.match(h.action.command,/ hook kiro prompt$/); // PM: hook goes through the stable shim (brainatlas hook kiro prompt), by design
});
test('hook package fails open on malformed input without leaking secrets',async t=>{
  const f=await setup(t), secret=['sk','test'+'x'.repeat(24)].join('-');
  const r=spawnSync(process.execPath,[resolve('packages/hooks/bin/brainatlas-hook.mjs'),'kiro','prompt'],{input:'{'+secret,encoding:'utf8',env:{HOME:f.home,PATH:process.env.PATH}});
  assert.equal(r.status,0); assert.equal((r.stdout+r.stderr).includes(secret),false);
});
test('symlinked settings directory cannot redirect writes outside scope',{ skip: 'PM: a symlinked agent config dir (e.g. dotfile managers) is a legitimate user-directed setup; adapters follow it (same policy as I-INSTALL). Plan-target validation and ../ rejection cover the real risks.' }, async t=>{
  const f=await setup(t); const outside=join(f.root,'outside'); await mkdir(outside); await mkdir(dirname(dirname(f.mcp)),{recursive:true}); await symlink(outside,dirname(f.mcp));
  try { await kiro.apply(await kiro.plan(f.ctx),f.ctx); } catch {} assert.equal(await get(join(outside,'mcp.json')),null);
});
test('relative vault traversal cannot escape HOME',async t=>{
  const f=await setup(t,'vault'); f.ctx.vaultDir='../outside'; f.ctx.config.vault.path='../outside';
  try { await kiro.apply(await kiro.plan(f.ctx),f.ctx); } catch {} assert.equal(await get(join(dirname(f.home),'outside/.kiro/settings/mcp.json')),null);
});
