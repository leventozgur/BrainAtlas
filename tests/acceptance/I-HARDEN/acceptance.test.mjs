// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { main } from '../../../packages/cli/src/index.mjs';
import { appendLog, readPage } from '../../../packages/core/src/vault/index.mjs';
import { createSearcher } from '../../../packages/core/src/retrieval/index.mjs';

const secret = ['sk', 'test' + 'x'.repeat(24)].join('-');
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'harden-')); t.after(() => rm(root, {recursive:true, force:true}));
  const home = join(root, 'home'); await mkdir(home);
  const env = { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: join(home,'config'), XDG_DATA_HOME: join(home,'data'), XDG_STATE_HOME: join(home,'state'), BRAINATLAS_PLATFORM:'linux', BRAINATLAS_OFFLINE:'1' };
  const run = (...args) => spawnSync(process.execPath, [resolve('packages/cli/bin/brainatlas.mjs'), ...args], {env, encoding:'utf8'});
  return {root, home, env, run};
}

test('plan outputs conceal HOME and journal secrets, including nested fields', async t => {
  const {home, env, run} = await fixture(t);
  const journal = join(env.XDG_STATE_HOME,'brainatlas','update-journal.json'); await mkdir(join(env.XDG_STATE_HOME,'brainatlas'), {recursive:true});
  await writeFile(journal, JSON.stringify({schemaVersion:1, kind:'update', phase:'switching', version:'1.0.0', target:'releases/1.0.0', previous:'releases/0.9.0', staging:null, path:join(home,'private'), token:secret, nested:{password:secret}}));
  for (const args of [['init','--yes','--vault',join(home,'vault')], ['config','set','sync.options.remote','https://example.org'], ['module','remove','nonexistent'], ['uninstall'], ['recover']]) {
    const r = run(...args,'--plan','--json'); const output = r.stdout + r.stderr;
    assert.ok(!output.includes(home), `${args[0]} leaks HOME`); assert.ok(!output.includes(secret), `${args[0]} leaks secret`);
  }
  const r = run('recover','--plan','--json'); assert.equal(r.status,0,r.stderr); assert.match(r.stdout, /\[REDACTED\]/); assert.match(r.stdout, /~\/private/);
});

test('metadata uses injected fetch online and never calls it offline; failures are contained', async t => {
  const {env} = await fixture(t); const original = console.log; const logs = []; console.log = x => logs.push(x); t.after(() => {console.log = original;});
  let calls = 0; const fetch = async () => { calls++; return {ok:true, json:async()=>({version:'9.0.0'})}; };
  await main(['update','--check','--json'], {...env, BRAINATLAS_UPDATE_METADATA_URL:'https://example.invalid/metadata'}, {fetch});
  assert.equal(calls,0); assert.equal(JSON.parse(logs.pop()).reason,'offline');
  await main(['update','--check','--json'], {...env, BRAINATLAS_OFFLINE:'0', BRAINATLAS_UPDATE_METADATA_URL:'https://example.invalid/metadata'}, {fetch});
  assert.equal(calls,1); assert.equal(JSON.parse(logs.pop()).offeredVersion,'9.0.0');
  await main(['update','--check','--json'], {...env, BRAINATLAS_OFFLINE:'0', BRAINATLAS_UPDATE_METADATA_URL:'https://example.invalid/metadata'}, {fetch:async()=>{throw new Error(secret);}});
  const failure = logs.pop(); assert.equal(JSON.parse(failure).reason,'metadata-unavailable'); assert.ok(!failure.includes(secret));
});

test('credential URL warns and is redacted for scalar and object config reads', async t => {
  const {run} = await fixture(t); const url = `https://user:${secret}@example.invalid/repo`;
  const set = run('config','set','sync.options.remote',url,'--json'); assert.equal(set.status,0,set.stderr); assert.match(set.stderr,/credential/i); assert.ok(JSON.parse(set.stdout).warnings.length); assert.ok(!(set.stdout+set.stderr).includes(secret));
  for (const key of ['sync.options.remote','sync.options','sync']) {
    const get = run('config','get',key,'--json'); assert.equal(get.status,0,get.stderr); assert.ok(!(get.stdout+get.stderr).includes(secret), `${key} exposed credential`);
  }
  const plain = run('config','set','sync.options.remote','https://example.invalid/repo','--json'); assert.equal(plain.status,0); assert.doesNotMatch(plain.stderr,/credential/i);
});

test('interrupted cache and log writes preserve prior content; traversal and symlinks are rejected', async t => {
  const {root} = await fixture(t); const vault = join(root,'vault'), state = join(root,'state'); await mkdir(join(vault,'wiki'),{recursive:true}); await mkdir(state);
  await writeFile(join(vault,'wiki','page.md'),'# Alpha\nalpha evidence\n'); const cache = join(state,'retrieval-index.json'); await writeFile(cache,'previous cache');
  const searcher = createSearcher({vaultDir:vault,stateDir:state,atomicWriter:()=>{throw new Error('interrupted');}}); assert.equal(await readFile(cache,'utf8'),'previous cache'); assert.ok(searcher.search('alpha',{abstainThreshold:0}).results.length);
  const log = join(vault,'wiki','log.md'); await writeFile(log,'existing\n'); await assert.rejects(appendLog(vault,{action:'update'}, {atomicWriter:async()=>{throw new Error('interrupted');}})); assert.equal(await readFile(log,'utf8'),'existing\n');
  await appendLog(vault,{action:'update',path:'wiki/page.md',token:secret},{now:new Date('2020-01-01T00:00:00Z')}); assert.ok(!(await readFile(log,'utf8')).includes(secret));
  await assert.rejects(readPage(vault,'../outside.md')); const outside = join(root,'outside.md'); await writeFile(outside,'untouched'); await symlink(outside,join(vault,'wiki','link.md')); await assert.rejects(readPage(vault,'wiki/link.md')); assert.equal(await readFile(outside,'utf8'),'untouched');
});

test('doctor without modules omits module rows and reports missing release as error', async t => {
  const {run} = await fixture(t); const r = run('doctor','--json'); assert.equal(r.status,1); const result = JSON.parse(r.stdout); assert.equal(result.ok,false); assert.deepEqual(result.modules ?? result.moduleHealth ?? [],[]);
});

test('credential redaction applies at every config level and to status, doctor and plans', async t => {
  const {run} = await fixture(t);
  const url = `https://user:${secret}@example.invalid/repo`;
  const set = run('config','set','sync.options.remote',url,'--json');
  assert.equal(set.status, 0, set.stderr);
  for (const args of [
    ['config','get'], ['config','get','sync'], ['config','get','sync.options'],
    ['config','get','sync.options.remote'], ['config','get','sync','--plan'],
    ['config','set','sync.options.remote',url,'--plan'], ['status'], ['doctor']
  ]) {
    for (const json of [false, true]) {
      const r = run(...args, ...(json ? ['--json'] : []));
      assert.ok(!(r.stdout + r.stderr).includes(secret), `${args.join(' ')} json=${json}`);
      assert.ok(!(r.stdout + r.stderr).includes(url), `${args.join(' ')} exposed URL`);
      if (args[0] === 'config') assert.equal(r.status, 0, r.stderr);
    }
  }
  const invalid = run('config','get','../sync','--json');
  assert.notEqual(invalid.status, 0); assert.ok(!(invalid.stdout + invalid.stderr).includes(secret));
});

test('rollback plan succeeds without exposing HOME; unavailable targets fail safely', async t => {
  const {home, env, run} = await fixture(t);
  const data = join(env.XDG_DATA_HOME, 'brainatlas');
  await mkdir(join(data, 'releases', '1.0.0'), {recursive:true});
  await mkdir(join(data, 'releases', '2.0.0'), {recursive:true});
  await symlink('releases/2.0.0', join(data, 'current'));
  const good = run('rollback','--to','1.0.0','--plan','--json');
  assert.equal(good.status, 0, good.stderr);
  assert.equal(JSON.parse(good.stdout).to, 'releases/1.0.0');
  assert.ok(!(good.stdout + good.stderr).includes(home));
  const bad = run('rollback','--to','../outside','--plan','--json');
  assert.notEqual(bad.status, 0); assert.ok(!(bad.stdout + bad.stderr).includes(home));
});

test('signed update plan hides the archive HOME path and rejects a corrupt archive', async t => {
  const {home, env} = await fixture(t);
  const {buildRelease} = await import('../../../release/build-release.mjs');
  const {signRelease} = await import('../../../release/sign.mjs');
  const key = join(home, 'signing-key');
  const keygen = spawnSync('ssh-keygen', ['-q','-t','ed25519','-N','','-f',key], {env, encoding:'utf8'});
  assert.equal(keygen.status, 0, keygen.stderr);
  const signers = join(home, 'signers');
  await writeFile(signers, `brainatlas-release ${(await readFile(`${key}.pub`, 'utf8')).trim()}\n`);
  const [archive, sums] = await buildRelease({version:'1.0.0-acceptance.1',profile:'lite',out:join(home,'release')});
  signRelease(key, sums);
  const run = file => spawnSync(process.execPath, [resolve('packages/cli/bin/brainatlas.mjs'),'update','--from',file,'--plan','--json'], {env:{...env,BRAINATLAS_ALLOWED_SIGNERS:signers}, encoding:'utf8'});
  const good = run(archive); assert.equal(good.status, 0, good.stderr);
  assert.match(JSON.parse(good.stdout).from, /^~\//); assert.ok(!(good.stdout + good.stderr).includes(home));
  await writeFile(archive, 'corrupt');
  const bad = run(archive); assert.notEqual(bad.status, 0); assert.ok(!(bad.stdout + bad.stderr).includes(secret));
});

test('vault atomic replacement cleans a fully written temporary file when rename fails', async t => {
  const {root} = await fixture(t);
  const fs = await import('node:fs/promises');
  const {atomicWriteFile} = await import('../../../packages/core/src/util/index.mjs');
  const wiki = join(root, 'wiki'); await mkdir(wiki);
  const log = join(wiki, 'log.md'); await writeFile(log, 'before\n');
  const fsOps = {...fs, rename: async () => { throw new Error('rename interrupted'); }};
  await assert.rejects(appendLog(root, {action:'update'}, {atomicWriter:(file, data) => atomicWriteFile(file, data, {fsOps})}), /rename interrupted/);
  assert.equal(await readFile(log, 'utf8'), 'before\n');
  assert.deepEqual(await fs.readdir(wiki), ['log.md']);
  await appendLog(root, {action:'update'}, {now:new Date('2020-01-01T00:00:00Z')});
  assert.match(await readFile(log, 'utf8'), /update/);
});

test('successful module removal plan redacts a secret-shaped module name', async t => {
  const {env, home, run} = await fixture(t);
  const data = join(env.XDG_DATA_HOME, 'brainatlas');
  const moduleDir = join(data, 'releases', '1.0.0', 'modules', secret);
  await mkdir(moduleDir, {recursive:true});
  const manifest = JSON.parse(await readFile('modules/semantic/module.json', 'utf8'));
  manifest.name = secret;
  await writeFile(join(moduleDir, 'module.json'), JSON.stringify(manifest));
  await symlink('releases/1.0.0', join(data, 'current'));
  const result = run('module','remove',secret,'--plan','--json');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).action, 'module remove');
  assert.ok(!(result.stdout + result.stderr).includes(secret));
  assert.ok(!(result.stdout + result.stderr).includes(home));
});
