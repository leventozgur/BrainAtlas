// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, link, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runHook, buildHookCommand } from '../../packages/hooks/src/index.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'hooks-test-')); t.after(() => rm(root,{recursive:true,force:true}));
  const vault = join(root,'vault'), state = join(root,'state'); await mkdir(vault); await mkdir(state);
  await writeFile(join(vault,'topic.md'), '# Topic\nknowledge topic evidence');
  return {root,vault,state,config:{vault:{path:vault},stateDir:state,hooks:{mode:'normal',deadlineMs:4700},retrieval:{abstainThreshold:0}}};
}
const call = (config, client='claude', event='prompt', data={session_id:'session',prompt:'topic'}) => runHook({client,event,stdin:JSON.stringify(data),env:{},now:new Date('2025-01-01'),config});
test('client envelopes, session handoff and unsupported events', async t => {
  const f = await fixture(t);
  for (const client of ['claude','codex','kiro']) {
    const r = await call(f.config,client); assert.equal(r.exitCode,0);
    if (client === 'kiro') assert.match(r.stdout,/Topic/);
    else assert.equal(JSON.parse(r.stdout).hookSpecificOutput.hookEventName,'UserPromptSubmit');
  }
  assert.equal((await call(f.config,'copilot','prompt')).stdout,'{}');
  const gemini=await call(f.config,'gemini');
  assert.equal(gemini.exitCode,0);
  assert.deepEqual(JSON.parse(gemini.stdout),{hookSpecificOutput:{additionalContext:'Topic (topic.md)\n# Topic\nknowledge topic evidence'}});
  assert.equal((await runHook({client:'gemini',event:'prompt',stdin:'{}',config:{...f.config,hooks:{mode:'manual'}}})).stdout,'{}');
  assert.equal((await call(f.config,'claude','session-start')).stdout,'{}');
  await writeFile(join(f.state,'handoff.md'),'continuity');
  assert.equal(JSON.parse((await call(f.config,'copilot','session-start')).stdout).additionalContext,'continuity');
  assert.equal(JSON.parse((await call(f.config,'claude','session-start')).stdout).hookSpecificOutput.hookEventName,'SessionStart');
  assert.equal((await runHook({client:'unknown',event:'prompt'})).exitCode,2);
});
test('malformed input, manual and economic triggers and per-client dedup', async t => {
  const f = await fixture(t); f.config.hooks.mode = 'manual';
  assert.equal((await runHook({client:'claude',event:'prompt',stdin:'{',config:f.config})).stdout,'{}');
  assert.equal((await call(f.config)).stdout,'{}');
  assert.match((await call(f.config,'claude','prompt',{session_id:'s',prompt:'/sb topic'})).stdout,/Topic/);
  assert.equal((await call(f.config,'claude','prompt',{session_id:'s',prompt:'@sb topic'})).stdout,'{}');
  assert.match((await call(f.config,'codex','prompt',{session_id:'s',prompt:'@sb topic'})).stdout,/Topic/);
  f.config.hooks.mode = 'economic'; assert.equal((await call(f.config,'kiro')).stdout,'');
  assert.match((await call(f.config,'kiro','prompt',{prompt:'what is topic?'})).stdout,/Topic/);
});
test('limits, deadline and content-free metrics', async t => {
  const f = await fixture(t); await writeFile(join(f.vault,'topic.md'), '# Topic\n' + 'topic '.repeat(2000));
  for (const client of ['claude','codex','kiro']) { const r = await call(f.config,client); assert.ok(r.stdout.length <= (client === 'codex' ? 1400 : 4002)); assert.ok(r.stdout.length > 0); }
  f.config.hooks.deadlineMs = 1; assert.equal((await call(f.config,'claude','prompt',{session_id:'different',prompt:'topic'})).stdout,'{}');
  const records = (await readFile(join(f.state,'metrics','hooks.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(Object.keys(records[0]).sort(),['ts','client','event','mode','durationMs','chars','results','outcome','session'].sort());
  assert.doesNotMatch(JSON.stringify(records),/topic|different|session_id/); assert.equal(records.at(-1).outcome,'deadline');
});
test('rejects linked state and metrics files', async t => {
  const f = await fixture(t); await mkdir(join(f.state,'metrics')); const target = join(f.root,'target'); await writeFile(target,'safe',{mode:0o600});
  await link(target,join(f.state,'metrics','hooks.jsonl')); await call(f.config); assert.equal(await readFile(target,'utf8'),'safe');
  await mkdir(join(f.state,'hooks'),{recursive:true}); const {createHash} = await import('node:crypto'); const name = createHash('sha256').update('other').digest('hex');
  await symlink(target,join(f.state,'hooks',`claude-${name}.json`)); assert.equal((await call(f.config,'claude','prompt',{session_id:'other',prompt:'topic'})).stdout,'{}');
});
test('command and cold start', async t => {
  const f = await fixture(t); const bin = resolve('packages/hooks/bin/brainatlas-hook.mjs');
  const cmd = buildHookCommand({nodePath:process.execPath,shimPath:bin,client:'gemini',event:'prompt',paths:{vault:f.vault,state:f.state,release:resolve('.')}}); assert.equal(cmd.at(-1),'prompt');
  const env = {PATH:process.env.PATH,HOME:f.root,XDG_CONFIG_HOME:join(f.root,'config'),XDG_STATE_HOME:join(f.root,'xdg-state'),XDG_DATA_HOME:join(f.root,'data')};
  const {resolvePaths} = await import('../../packages/core/src/paths/index.mjs'); const {dirname} = await import('node:path'); const configFile = resolvePaths({env}).configFile; await mkdir(dirname(configFile),{recursive:true});
  const {defaultConfig} = await import('../../packages/core/src/config/index.mjs'); const cfg = defaultConfig('lite'); cfg.vault.path = f.vault; cfg.hooks.deadlineMs = 4700; cfg.retrieval.abstainThreshold = 0;
  await writeFile(configFile,JSON.stringify(cfg));
  const measure = () => Array.from({length:20},()=>{const start=performance.now(); const r=spawnSync(process.execPath,[bin,'claude','prompt'],{input:JSON.stringify({prompt:'topic'}),env,encoding:'utf8'}); assert.equal(r.status,0); assert.match(r.stdout,/Topic/); return performance.now()-start;}).sort((a,b)=>a-b)[18];
  let p95 = measure(); if (p95 >= 300) p95 = measure(); assert.ok(p95 < 300,`p95 ${p95} ms`);
  if (!cmd.includes('--permission')) t.diagnostic('Node permission model unavailable; outside-path check skipped');
  else { const {realpath} = await import('node:fs/promises'); const probe = join(await realpath(f.state),'probe.mjs'); await writeFile(probe, "import {readFileSync} from 'node:fs'; readFileSync(process.argv[2]);"); const flags = cmd.slice(1,cmd.indexOf(bin)); const allowed = spawnSync(process.execPath,[...flags,probe,join(await realpath(f.vault),'topic.md')],{env,encoding:'utf8'}); assert.equal(allowed.status,0,allowed.stderr); const r = spawnSync(process.execPath,[...flags,probe,'/etc/passwd'],{env,encoding:'utf8'}); assert.notEqual(r.status,0); assert.match(r.stderr,/ERR_ACCESS_DENIED/); }
});
test('rejects symlinked state subdirectories', async t => {
  for (const name of ['hooks', 'metrics']) {
    const f = await fixture(t); const outside = join(f.root, 'outside'); await mkdir(outside);
    await symlink(outside, join(f.state, name));
    await call(f.config);
    const {readdir} = await import('node:fs/promises');
    assert.deepEqual(await readdir(outside), []);
  }
});
test('permission command runs with the supplied config file', async t => {
  const f = await fixture(t); const bin = resolve('packages/hooks/bin/brainatlas-hook.mjs');
  const env = {PATH:process.env.PATH, HOME:f.root, XDG_CONFIG_HOME:join(f.root,'config'), XDG_STATE_HOME:join(f.root,'xdg-state'), XDG_DATA_HOME:join(f.root,'data')};
  const {resolvePaths, vaultId} = await import('../../packages/core/src/paths/index.mjs');
  const {dirname} = await import('node:path'); const paths = resolvePaths({env});
  await mkdir(dirname(paths.configFile), {recursive:true});
  const {defaultConfig} = await import('../../packages/core/src/config/index.mjs');
  const config = defaultConfig('lite'); config.vault.path = f.vault; config.retrieval.abstainThreshold = 0;
  await writeFile(paths.configFile, JSON.stringify(config));
  await mkdir(join(paths.stateDir,vaultId(f.vault)), {recursive:true});
  const command = buildHookCommand({nodePath:process.execPath,shimPath:bin,client:'claude',event:'prompt',paths:{vault:f.vault,state:join(paths.stateDir,vaultId(f.vault)),release:resolve('.'),configFile:paths.configFile}});
  const result = spawnSync(command[0],command.slice(1),{env,input:JSON.stringify({session_id:'s',prompt:'topic'}),encoding:'utf8'});
  assert.equal(result.status,0,result.stderr); assert.match(result.stdout,/Topic/,result.stderr);
});
