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
