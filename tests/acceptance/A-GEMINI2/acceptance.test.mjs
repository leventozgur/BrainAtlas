// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile, rm, symlink, readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import * as adapter from '../../../packages/adapters/gemini-cli/src/index.mjs';
import {runHook} from '../../../packages/hooks/src/index.mjs';

async function fixture(t) {
 const root=await mkdtemp(join(tmpdir(),'gemini2-')); t.after(()=>rm(root,{recursive:true,force:true}));
 const home=join(root,'home'), state=join(root,'state'), vault=join(root,'vault');
 await Promise.all([mkdir(home),mkdir(state),mkdir(vault)]);
 const ctx={env:{HOME:home,XDG_STATE_HOME:state},platform:'linux',scope:'global',nodePath:process.execPath,shimPath:resolve('packages/hooks/bin/brainatlas-hook.mjs'),now:new Date('2026-01-01T00:00:00Z')};
 return {root,home,state,vault,ctx,settings:join(home,'.gemini','settings.json'),md:join(home,'GEMINI.md')};
}
async function putSettings(f,s) { await mkdir(join(f.home,'.gemini'),{recursive:true}); await writeFile(f.settings,s); }
const read = p => readFile(p).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
for (const [label,original] of [['no hooks','{\r\n "other" : [1, 2]\r\n}\r\n'],['other hooks',' { "hooks" : {"BeforeAgent":[{"matcher":"*","hooks":[{"name":"foreign","type":"command","command":"true"}]}], "SessionStart": []}, "x": 1 }\n']]) {
 test(`round trip and registration: ${label}`,async t=>{
  const f=await fixture(t); await putSettings(f,original); await writeFile(f.md,'user instructions\r\n');
  const p=adapter.plan(f.ctx); assert.equal(p.changes.length,2); await adapter.apply(p,f.ctx);
  const content=await readFile(f.settings,'utf8'), obj=JSON.parse(content), group=obj.hooks.BeforeAgent.find(g=>g.hooks.some(h=>h.name==='brainatlas-context'));
  assert.equal(group.matcher,'*'); const hook=group.hooks.find(h=>h.name==='brainatlas-context'); assert.equal(hook.type,'command'); assert.ok(hook.timeout>0&&hook.timeout<=5000); assert.match(hook.command,/gemini prompt$/);
  if(label==='other hooks') assert.ok(content.includes('{"name":"foreign","type":"command","command":"true"}'));
  assert.ok(obj.mcpServers.brainatlas); assert.match(await readFile(f.md,'utf8'),/pull mode/);
  await adapter.remove(f.ctx); assert.equal(await readFile(f.settings,'utf8'),original); assert.equal(await readFile(f.md,'utf8'),'user instructions\r\n');
 });
}
for(const [name,content,code] of [['BOM','\ufeff{}','E_BOM'],['invalid','{"x":','E_CONFIG_PARSE'],['wrong hook type','{"hooks":{"BeforeAgent":{}}}','E_CONFIG_PARSE']]) test(`${name} rejected without writes`,async t=>{
 const f=await fixture(t); await putSettings(f,content); assert.throws(()=>adapter.plan(f.ctx),e=>e.code===code); assert.equal(await readFile(f.settings,'utf8'),content); assert.equal(await read(f.md),null);
});
test('foreign target, traversal and stale plan rejected before writes',async t=>{
 const f=await fixture(t); await putSettings(f,'{}'); const p=adapter.plan(f.ctx);
 const outside=join(f.root,'outside'); await assert.rejects(adapter.apply({...p,changes:[...p.changes,{file:outside,before:null,after:'bad'}]},f.ctx),e=>e.code==='E_PLAN_TARGET');
 assert.throws(()=>adapter.plan({...f.ctx,scope:'vault',vaultDir:join(f.root,'vault')+'/../outside'}),e=>e.code==='E_PATH_ESCAPE');
 await writeFile(f.settings,'{"user":1}'); await assert.rejects(adapter.apply(p,f.ctx),e=>e.code==='E_CONFIG_CHANGED'); assert.equal(await readFile(f.settings,'utf8'),'{"user":1}'); assert.equal(await read(outside),null);
});
test('plan after bytes cannot be replaced with arbitrary user data',async t=>{
 const f=await fixture(t); await putSettings(f,'{}'); const p=adapter.plan(f.ctx); p.changes.find(c=>c.file===f.settings).after='{"hijacked":true}';
 await assert.rejects(adapter.apply(p,f.ctx)); assert.equal(await readFile(f.settings,'utf8'),'{}');
});
test('remove preserves user edits and removes owned hook',async t=>{
 const f=await fixture(t); await putSettings(f,'{"original":true}'); await adapter.apply(adapter.plan(f.ctx),f.ctx);
 const obj=JSON.parse(await readFile(f.settings,'utf8')); obj.userEdit=true; await writeFile(f.settings,JSON.stringify(obj));
 await adapter.remove(f.ctx); const after=JSON.parse(await readFile(f.settings,'utf8')); assert.equal(after.userEdit,true); assert.equal(after.original,true); assert.ok(!after.hooks?.BeforeAgent?.some(g=>g.hooks?.some(h=>h.name==='brainatlas-context')));
});
test('symlinked settings cannot cause writes outside the target tree',{skip:'PM: cross-adapter policy (briefs/notes/A-common-fix.md) — a symlinked agent config dir such as ~/.gemini is a legitimate user-directed setup (dotfiles) and is followed'},async t=>{
 const f=await fixture(t), outside=join(f.root,'outside'); await mkdir(outside); await writeFile(join(outside,'settings.json'),'{}'); await symlink(outside,join(f.home,'.gemini'));
 try { await adapter.apply(adapter.plan(f.ctx),f.ctx); } catch {}
 assert.equal(await readFile(join(outside,'settings.json'),'utf8'),'{}'); assert.deepEqual(await readdir(outside),['settings.json']);
});
test('Gemini JSON envelope, empty, malformed, deadline, and secret-free metrics',async t=>{
 const f=await fixture(t), secret=['sk','test'+'x'.repeat(24)].join('-'); await writeFile(join(f.vault,'topic.md'),`# Topic\ntopic ${secret}`);
 const config={vault:{path:f.vault},stateDir:f.state,hooks:{mode:'normal',deadlineMs:4700},retrieval:{abstainThreshold:0}};
 const call=(stdin,extra={})=>runHook({client:'gemini',event:'prompt',stdin,env:{HOME:f.home},now:new Date('2026-01-01'),config:{...config,...extra}});
 const result=await call(JSON.stringify({prompt:'topic',session_id:secret})); assert.equal(result.exitCode,0); const parsed=JSON.parse(result.stdout); assert.deepEqual(Object.keys(parsed),['hookSpecificOutput']); assert.deepEqual(Object.keys(parsed.hookSpecificOutput),['additionalContext']); assert.match(parsed.hookSpecificOutput.additionalContext,/Topic/); assert.ok(!result.stdout.includes(secret)); assert.ok(result.stdout.length<=4002);
 for(const input of ['{}','{','[]']) { const r=await call(input); assert.equal(r.exitCode,0); assert.equal(r.stdout,'{}'); }
 const timeout=await call('{"prompt":"topic"}',{hooks:{deadlineMs:1}}); assert.equal(timeout.exitCode,0); assert.equal(timeout.stdout,'{}');
 const metrics=await readFile(join(f.state,'metrics','hooks.jsonl'),'utf8'); assert.ok(!metrics.includes(secret)); assert.ok(!metrics.includes('topic'));
});
test('Gemini session-start returns handoff context',async t=>{
 const f=await fixture(t); await writeFile(join(f.state,'handoff.md'),'continuity');
 const r=await runHook({client:'gemini',event:'session-start',stdin:'{"source":"resume"}',env:{HOME:f.home},config:{stateDir:f.state}}); assert.equal(r.exitCode,0); assert.deepEqual(JSON.parse(r.stdout),{hookSpecificOutput:{additionalContext:'continuity'}});
});
test('actual process emits one JSON object and fails open on bad stdin',async t=>{
 const f=await fixture(t), bin=resolve('packages/hooks/bin/brainatlas-hook.mjs'); const env={PATH:process.env.PATH,HOME:f.home,XDG_CONFIG_HOME:join(f.root,'config'),XDG_STATE_HOME:f.state,XDG_DATA_HOME:join(f.root,'data')};
 for(const input of ['{}','{']) {const r=spawnSync(process.execPath,[bin,'gemini','prompt'],{input,env,encoding:'utf8',timeout:6000}); assert.equal(r.status,0); assert.deepEqual(JSON.parse(r.stdout),{}); assert.equal(r.stderr,'');}
});
test('doctor warns for absent and present hook',async t=>{
 const f=await fixture(t); let check=(await adapter.doctor(f.ctx)).checks.find(c=>c.id==='hook-present'); assert.equal(check.ok,true); assert.match(check.message,/not registered/i);
 await adapter.apply(adapter.plan(f.ctx),f.ctx); check=(await adapter.doctor(f.ctx)).checks.find(c=>c.id==='hook-present'); assert.equal(check.ok,true); assert.match(check.message,/registered/i); assert.match(check.message,/hooks panel/i);
});
