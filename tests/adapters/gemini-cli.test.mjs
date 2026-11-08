// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as adapter from '../../packages/adapters/gemini-cli/src/index.mjs';

async function setup(scope='global') {
  const base=await mkdtemp(join(tmpdir(),'brainatlas-gemini-')), home=join(base,'home'), vault=join(base,'vault');
  await mkdir(home,{recursive:true}); await mkdir(vault,{recursive:true});
  const ctx={env:{HOME:home,XDG_STATE_HOME:join(base,'state')},platform:'linux',scope,vaultDir:vault,nodePath:'/opt/node',shimPath:'/opt/brainatlas/bin/brainatlas',now:new Date('2026-01-02T03:04:05Z')};
  return {base,ctx,root:scope==='vault'?vault:home};
}
const files = root => ({mcp:join(root,'.gemini','settings.json'),md:join(root,'GEMINI.md')});
async function cleanup(base) { await rm(base,{recursive:true,force:true}); }

test('detect and plan are explicit; plan does not write', async t => {
  const x=await setup(); t.after(()=>cleanup(x.base));
  assert.equal(adapter.detect({HOME:x.ctx.env.HOME,GEMINI_CLI:'1'}),true);
  assert.equal(adapter.detect({HOME:x.ctx.env.HOME}),false);
  const p=adapter.plan(x.ctx); assert.equal(p.changes.length,2); assert.equal(p.trustReviewRequired,true);
  assert.equal(await readFile(files(x.root).md).then(()=>true,()=>false),false);
});

for (const fixture of ['empty','existing']) test(`apply then remove restores bytes exactly (${fixture})`, async t => {
  const x=await setup(), f=files(x.root); t.after(()=>cleanup(x.base));
  if (fixture==='existing') {
    await mkdir(join(x.root,'.gemini'),{recursive:true});
    await writeFile(f.mcp,'{\n    "other": {"keep": true},\n    "mcpServers": {"other": {"command": "x"}}\n}\n');
    await writeFile(f.md,'# User instructions\r\nKeep this.\r\n');
  }
  const originals={mcp:await readFile(f.mcp).catch(()=>null),md:await readFile(f.md).catch(()=>null)};
  const p=adapter.plan(x.ctx); await adapter.apply(p,x.ctx);
  const second=adapter.plan(x.ctx); assert.equal(second.changes.length,0);
  if (fixture==='existing') { const after=JSON.parse(await readFile(f.mcp,'utf8')); assert.equal(after.other.keep,true); assert.equal(after.mcpServers.other.command,'x'); }
  await adapter.remove(x.ctx);
  assert.deepEqual(await readFile(f.mcp).catch(()=>null),originals.mcp);
  assert.deepEqual(await readFile(f.md).catch(()=>null),originals.md);
});

for (const [name, content] of [['zero-byte', ''], ['whitespace-only', ' \t\r\n']]) test(`apply then remove restores an existing ${name} settings file exactly`, async t => {
  const x=await setup(), f=files(x.root); t.after(()=>cleanup(x.base));
  await mkdir(join(x.root,'.gemini'),{recursive:true});
  await writeFile(f.mcp,content);
  const p=adapter.plan(x.ctx);
  await adapter.apply(p,x.ctx);
  await adapter.remove(x.ctx);
  assert.equal(await readFile(f.mcp,'utf8'),content);
});

for (const [name,content,code] of [['broken','{oops','E_CONFIG_PARSE'],['BOM','\uFEFF{}','E_BOM']]) test(`refuses ${name} config without changes`, async t => {
  const x=await setup(), f=files(x.root); t.after(()=>cleanup(x.base));
  await mkdir(join(x.root,'.gemini'),{recursive:true}); await writeFile(f.mcp,content);
  assert.throws(()=>adapter.plan(x.ctx),e=>e.code===code);
  assert.equal(await readFile(f.mcp,'utf8'),content);
});

test('vault scope targets project files and tampered managed blocks fail before writes', async t => {
  const x=await setup('vault'), f=files(x.root); t.after(()=>cleanup(x.base));
  assert.equal(adapter.plan(x.ctx).changes.every(c=>c.file.startsWith(x.root)),true);
  const p=adapter.plan(x.ctx); await adapter.apply(p,x.ctx);
  await writeFile(f.md,(await readFile(f.md,'utf8')).replace('pull mode','edited mode'));
  const before=await readFile(f.mcp,'utf8');
  await assert.rejects(adapter.remove(x.ctx),e=>e.code==='E_MANAGED_BLOCK_EDITED');
  assert.equal(await readFile(f.mcp,'utf8'),before);
});

test('doctor and trust review describe pull mode', async t => {
  const x=await setup(); t.after(()=>cleanup(x.base));
  const review=await adapter.trustReview(x.ctx); assert.equal(review.required,true); assert.equal(review.client,'Gemini CLI');
  const health=await adapter.doctor(x.ctx); assert.equal(health.checks.some(c=>c.id==='hook-present'&&c.ok),true);
});

test('restore a pre-existing BrainAtlas MCP entry byte-for-byte', async t => {
  const x=await setup(), f=files(x.root); t.after(()=>cleanup(x.base));
  await mkdir(join(x.root,'.gemini'),{recursive:true});
  const original=' { "mcpServers" : { "brainatlas" : {"command":"old","args":["old"]}, "other":{} } }';
  await writeFile(f.mcp,original);
  await adapter.apply(adapter.plan(x.ctx),x.ctx);
  await adapter.remove(x.ctx);
  assert.equal(await readFile(f.mcp,'utf8'),original);
});

test('registers BeforeAgent while preserving other hook and setting bytes', async t => {
  const x=await setup(), f=files(x.root); t.after(()=>cleanup(x.base));
  await mkdir(join(x.root,'.gemini'),{recursive:true});
  const foreign=' {\n  "theme" : { "color" : "blue" },\n  "hooks" : { "SessionStart" : [{"matcher":"startup","hooks":[{"name":"user-hook","type":"command","command":"example-command"}]}] }\n}\n';
  await writeFile(f.mcp,foreign);
  const plan=adapter.plan(x.ctx); assert.equal(plan.changes.length,2);
  await adapter.apply(plan,x.ctx);
  const after=await readFile(f.mcp,'utf8'), obj=JSON.parse(after);
  assert.ok(after.includes('"theme" : { "color" : "blue" }'));
  assert.ok(after.includes('"name":"user-hook","type":"command","command":"example-command"'));
  const registration=obj.hooks.BeforeAgent.find(group=>group.matcher==='*');
  assert.ok(registration);
  const command=registration.hooks[0];
  assert.equal(command.name,'brainatlas-context'); assert.equal(command.type,'command');
  assert.ok(command.timeout<=5000); assert.match(command.command,/hook gemini prompt$/);
  const session=obj.hooks.SessionStart.find(group=>group.matcher==='*').hooks[0];
  assert.match(session.command,/hook gemini session-start$/);
  for(const [hook,event] of [[command,'prompt'],[session,'session-start']]){
    assert.equal(hook.command,`"${x.ctx.nodePath}" "${x.ctx.shimPath}" hook gemini ${event}`);
  }
  const doctor=await adapter.doctor(x.ctx);
  assert.equal(doctor.checks.find(check=>check.id==='hook-present').ok,true);
  assert.match(doctor.checks.find(check=>check.id==='hook-present').message,/hooks panel/);
  await adapter.remove(x.ctx);
  assert.equal(await readFile(f.mcp,'utf8'),foreign);
});

test('upgrades legacy hooks in place and removes them without disturbing user hooks', async t => {
  const x=await setup(), f=files(x.root); t.after(()=>cleanup(x.base));
  await mkdir(join(x.root,'.gemini'),{recursive:true});
  const command=event=>`"${x.ctx.nodePath}" "${x.ctx.shimPath}" gemini ${event}`;
  const legacy=JSON.stringify({hooks:{BeforeAgent:[{matcher:'*',hooks:[{name:'user-hook',type:'command',command:'keep'}, {name:'brainatlas-context',type:'command',command:command('prompt')}]}],SessionStart:[{matcher:'*',hooks:[{name:'brainatlas-session',type:'command',command:command('session-start')}]}]}},null,2)+'\n';
  await writeFile(f.mcp,legacy);
  let health=await adapter.doctor(x.ctx);
  for(const id of ['hook-present','session-hook-present'])assert.equal(health.checks.find(c=>c.id===id).ok,false);
  await adapter.apply(adapter.plan(x.ctx),x.ctx);
  const updated=await readFile(f.mcp,'utf8'), config=JSON.parse(updated);
  for(const [event,name,suffix] of [['BeforeAgent','brainatlas-context','hook gemini prompt'],['SessionStart','brainatlas-session','hook gemini session-start']]){
    const entries=config.hooks[event].flatMap(g=>g.hooks).filter(h=>h.name===name);
    assert.equal(entries.length,1); assert.ok(entries[0].command.endsWith(suffix));
  }
  assert.ok(updated.includes('"name": "user-hook"'));
  assert.equal(adapter.plan(x.ctx).changes.length,0);
  health=await adapter.doctor(x.ctx);
  for(const id of ['hook-present','session-hook-present'])assert.equal(health.checks.find(c=>c.id===id).ok,true);
  await adapter.remove(x.ctx);
  const removed=await readFile(f.mcp,'utf8');
  assert.ok(removed.includes('"name": "user-hook"'));
  assert.doesNotMatch(removed,/brainatlas-context|brainatlas-session/);
});

test('deduplicates mixed legacy and current hooks and removes hooks after settings change', async t => {
  const x=await setup(), f=files(x.root); t.after(()=>cleanup(x.base));
  await mkdir(join(x.root,'.gemini'),{recursive:true});
  const base=`"${x.ctx.nodePath}" "${x.ctx.shimPath}"`;
  const entry=command=>({name:'brainatlas-context',type:'command',command});
  await writeFile(f.mcp,JSON.stringify({hooks:{BeforeAgent:[{matcher:'*',hooks:[entry(`${base} gemini prompt`),entry(`${base} hook gemini prompt`),{name:'user',type:'command',command:'keep'}]}]}}));
  await adapter.apply(adapter.plan(x.ctx),x.ctx);
  let config=JSON.parse(await readFile(f.mcp,'utf8'));
  assert.equal(config.hooks.BeforeAgent[0].hooks.filter(h=>h.name==='brainatlas-context').length,1);
  config.extra='preserve'; await writeFile(f.mcp,JSON.stringify(config));
  await adapter.remove(x.ctx);
  config=JSON.parse(await readFile(f.mcp,'utf8'));
  assert.equal(config.extra,'preserve');
  assert.deepEqual(config.hooks.BeforeAgent[0].hooks.map(h=>h.name),['user']);
});

test('a foreign plan target is rejected and malformed settings remain untouched', async t => {
  const x=await setup(), f=files(x.root); t.after(()=>cleanup(x.base));
  await mkdir(join(x.root,'.gemini'),{recursive:true});
  const malformed='\uFEFF{broken'; await writeFile(f.mcp,malformed);
  assert.throws(()=>adapter.plan(x.ctx),error=>error.code==='E_BOM');
  assert.equal(await readFile(f.mcp,'utf8'),malformed);
  await writeFile(f.mcp,'{}');
  const plan=adapter.plan(x.ctx); plan.changes.push({file:join(x.base,'outside'),before:null,after:'{}',kind:'create'});
  await assert.rejects(adapter.apply(plan,x.ctx),error=>error.code==='E_PLAN_TARGET');
  assert.equal(await readFile(f.mcp,'utf8'),'{}');
});
