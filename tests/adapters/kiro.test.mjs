// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as adapter from '../../packages/adapters/kiro/src/index.mjs';

const FIXTURES=resolve('tests/adapters/kiro/fixtures');
const makeCtx=(home,scope='global')=>({env:{HOME:home},config:{vault:{path:home}},scope,nodePath:'/path with spaces/node',shimPath:'/path with spaces/brainatlas',paths:{stateDir:join(home,'.state')},now:new Date('2026-11-08T12:00:00Z')});
async function fixture(name) {
  const root=await mkdtemp(join(tmpdir(),'kiro-adapter-'));
  const source=join(FIXTURES,name);
  if(name!=='empty') await cp(source,root,{recursive:true});
  return root;
}
async function snapshot(root) {
  const files=[];
  async function walk(dir) { let entries; try { entries=await readdir(dir,{withFileTypes:true}); } catch(e) { if(e.code==='ENOENT')return; throw e; }
    for(const ent of entries) { const full=join(dir,ent.name); if(ent.isDirectory()) await walk(full); else if(!ent.name.includes('.bak.')) files.push([full,await readFile(full)]); }
  }
  await walk(root); return files.map(([f,b])=>[f.slice(root.length),b.toString('base64')]).sort((a,b)=>a[0].localeCompare(b[0]));
}

test('detect requires injected HOME; plan is pure and describes MCP, steering, and hook',async()=>{
  assert.equal(adapter.detect({HOME:'/fake/home'}),true); assert.equal(adapter.detect({}),false);
  const home=await fixture('empty');
  try {
    const ctx=makeCtx(home), result=await adapter.plan(ctx);
    assert.equal(result.changes.length,3); assert.equal(await snapshot(home).then(x=>x.length),0);
    const mcp=result.changes.find(x=>x.file.endsWith('mcp.json'));
    assert.equal(JSON.parse(mcp.after).mcpServers.brainatlas.command,ctx.nodePath);
    assert.deepEqual(JSON.parse(mcp.after).mcpServers.brainatlas.args,[ctx.shimPath,'mcp']);
    const hook=result.changes.find(x=>x.file.endsWith('brainatlas.json'));
    assert.match(JSON.parse(hook.after).hooks[0].action.command,/"\/path with spaces\/node" "\/path with spaces\/brainatlas" hook kiro prompt/);
    assert.equal(adapter.KIRO_PROMPT_TRIGGER,'PromptSubmit');
  } finally { await rm(home,{recursive:true,force:true}); }
});

test('apply then remove restores exact bytes for empty and populated fixture homes',async t=>{
  for(const name of ['empty','existing']) await t.test(name,async()=>{
    const home=await fixture(name); const before=await snapshot(home); const ctx=makeCtx(home);
    try {
      const first=await adapter.plan(ctx); await adapter.apply(first,ctx);
      const second=await adapter.plan(ctx); assert.equal(second.changes.length,0,'apply is idempotent');
      await adapter.remove(ctx); assert.deepEqual(await snapshot(home),before);
    } finally { await rm(home,{recursive:true,force:true}); }
  });
});

test('invalid and BOM JSON stop without changing fixture bytes',async t=>{
  for(const [name,code] of [['broken','E_CONFIG_PARSE'],['bom','E_BOM']]) await t.test(name,async()=>{
    const home=await fixture(name), before=await snapshot(home);
    try { await assert.rejects(adapter.plan(makeCtx(home)),e=>e.code===code); assert.deepEqual(await snapshot(home),before); }
    finally { await rm(home,{recursive:true,force:true}); }
  });
});

test('user-edited managed steering block is refused',async()=>{
  const home=await fixture('empty'),ctx=makeCtx(home);
  try {
    await adapter.apply(await adapter.plan(ctx),ctx);
    const file=join(home,'.kiro/steering/brainatlas.md');
    await writeFile(file,(await readFile(file,'utf8')).replace('Prefer wiki_query','Prefer something else'));
    await assert.rejects(adapter.remove(ctx),e=>e.code==='E_MANAGED_BLOCK_EDITED');
  } finally { await rm(home,{recursive:true,force:true}); }
});

test('vault scope writes project configuration and doctor/trust review identify Kiro',async()=>{
  const home=await fixture('empty'),vault=join(home,'project'),ctx=makeCtx(home,'vault'); ctx.vaultDir=vault;
  try {
    ctx.shimPath=join(home,'bin with spaces','brainatlas'); await mkdir(join(home,'bin with spaces'),{recursive:true}); await writeFile(ctx.shimPath,'shim');
    const plan=await adapter.plan(ctx); assert(plan.changes.every(c=>c.file.startsWith(vault)));
    await adapter.apply(plan,ctx);
    const review=await adapter.trustReview(ctx); assert.equal(review.client,'Kiro'); assert.equal(review.required,true);
    const health=await adapter.doctor(ctx); assert.equal(health.checks.find(c=>c.id==='registered').ok,true); assert.equal(health.checks.find(c=>c.id==='command').ok,true); assert.equal(health.checks.find(c=>c.id==='hook').ok,true);
    assert.equal(health.checks.find(c=>c.id==='trigger-verified').warning,true); // PM hotfix: warning, not a failing check
    await adapter.remove(ctx);
  } finally { await rm(home,{recursive:true,force:true}); }
});

test('apply rechecks planned bytes and refuses concurrent edits',async()=>{
  const home=await fixture('empty'),ctx=makeCtx(home);
  try {
    const planned=await adapter.plan(ctx); await mkdir(join(home,'.kiro/settings'),{recursive:true});
    await writeFile(join(home,'.kiro/settings/mcp.json'),'{}\n');
    await assert.rejects(adapter.apply(planned,ctx),e=>e.code==='E_CONFIG_CHANGED');
  } finally { await rm(home,{recursive:true,force:true}); }
});
