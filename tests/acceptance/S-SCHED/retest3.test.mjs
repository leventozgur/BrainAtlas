// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultConfig, resolvePaths } from '@brainatlas/core';
import { commands } from '../../../modules/sync-engine/src/index.mjs';
import { main } from '../../../packages/cli/src/index.mjs';

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const stopWord = platform => (platform === 'darwin' ? 'bootout' : 'disable');

async function setup(t, platform, behave) {
  const root = await mkdtemp(join(tmpdir(), 's-sched3-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  await mkdir(home, { recursive: true });
  const env = { HOME: home, XDG_CONFIG_HOME: join(home, 'config'), XDG_DATA_HOME: join(home, 'data'), XDG_STATE_HOME: join(home, 'state'), BRAINATLAS_PLATFORM: platform, UID: '4242', PATH: process.env.PATH || '/usr/bin:/bin' };
  const paths = resolvePaths({ platform, env });
  const calls = [];
  const state = { stop: { code: 0 } };
  const runCommand = async (command, args) => {
    calls.push({ command, args });
    if (args.includes(stopWord(platform))) {
      if (state.stop.throws) throw new Error('boom');
      return state.stop;
    }
    return { code: 0, stdout: '' };
  };
  return { root, home, env, paths, calls, state, ctx: { config: defaultConfig('full'), paths, env, runCommand } };
}
const snap = async files => Promise.all(files.map(f => readFile(f)));
const absent = p => assert.rejects(lstat(p), { code: 'ENOENT' });

for (const platform of ['darwin', 'linux']) {
  test(`${platform}: stop failure (nonzero) keeps files, manifest, and retry succeeds`, async t => {
    const f = await setup(t, platform);
    const run = (...a) => commands.sync(['schedule', ...a], f.ctx);
    const inst = await run('install');
    const before = await snap(inst.files);
    const manifest = join(f.paths.stateDir, 'sync', 'scheduler.json');
    const mBefore = await readFile(manifest);
    f.state.stop = { code: 1, stderr: 'permission denied' };
    await assert.rejects(run('remove'), { code: 'E_SCHEDULER_COMMAND' });
    assert.deepEqual(await snap(inst.files), before);
    assert.deepEqual(await readFile(manifest), mBefore);
    f.state.stop = { code: 0 };
    const r = await run('remove');
    assert.deepEqual(r.removed.sort(), [...inst.files].sort());
    for (const file of inst.files) await absent(file);
    await absent(manifest);
  });

  test(`${platform}: stop runner throwing is E_SCHEDULER_COMMAND and preserves state`, async t => {
    const f = await setup(t, platform);
    const run = (...a) => commands.sync(['schedule', ...a], f.ctx);
    const inst = await run('install');
    f.state.stop = { throws: true };
    await assert.rejects(run('remove'), { code: 'E_SCHEDULER_COMMAND' });
    for (const file of inst.files) assert.ok((await lstat(file)).isFile());
    assert.equal((await run('status')).status, 'installed');
  });

  test(`${platform}: failure error does not leak stderr content`, async t => {
    const f = await setup(t, platform);
    const run = (...a) => commands.sync(['schedule', ...a], f.ctx);
    await run('install');
    const secret = ['tok', 'en-', 'ABC123xyz'].join('');
    f.state.stop = { code: 1, stderr: `fatal ${secret}`, stdout: secret };
    const err = await run('remove').catch(e => e);
    assert.equal(err.code, 'E_SCHEDULER_COMMAND');
    assert.ok(!JSON.stringify({ m: err.message, c: err.code, d: err.details }).includes(secret));
  });

  const notLoaded = platform === 'darwin'
    ? [{ code: 3, stderr: '' }, { code: 113, stderr: 'Could not find service "org.brainatlas.sync" in domain' }]
    : [{ code: 5, stderr: 'Failed to disable unit: Unit file brainatlas-sync.timer does not exist.' }, { code: 1, stderr: 'Unit brainatlas-sync.timer not loaded.' }];
  for (const [i, res] of notLoaded.entries()) {
    test(`${platform}: "not loaded" variant ${i} counts as success and removes files`, async t => {
      const f = await setup(t, platform);
      const run = (...a) => commands.sync(['schedule', ...a], f.ctx);
      const inst = await run('install');
      f.state.stop = res;
      const r = await run('remove');
      assert.equal(r.removed.length, inst.files.length);
      for (const file of inst.files) await absent(file);
      // second remove on clean system is an idempotent success
      const again = await run('remove');
      assert.deepEqual(again.removed, []);
    });
  }

  test(`${platform}: remove with nothing installed never calls the stop command`, async t => {
    const f = await setup(t, platform);
    const r = await commands.sync(['schedule', 'remove'], f.ctx);
    assert.deepEqual(r.removed, []);
    assert.equal(f.calls.filter(c => c.args.includes(stopWord(platform))).length, 0);
  });

  test(`${platform}: unrelated nonzero exit with unrecognized text is NOT treated as already stopped`, async t => {
    const f = await setup(t, platform);
    const run = (...a) => commands.sync(['schedule', ...a], f.ctx);
    const inst = await run('install');
    f.state.stop = { code: 2, stderr: 'something unexpected' };
    await assert.rejects(run('remove'), { code: 'E_SCHEDULER_COMMAND' });
    for (const file of inst.files) assert.ok((await lstat(file)).isFile());
  });

  test(`${platform}: user-modified managed file is preserved on remove (not owned bytes)`, async t => {
    const f = await setup(t, platform);
    const run = (...a) => commands.sync(['schedule', ...a], f.ctx);
    const inst = await run('install');
    await writeFile(inst.files[0], 'user edit\n', { mode: 0o600 });
    const r = await run('remove');
    assert.ok(r.preserved.includes(inst.files[0]));
    assert.equal(await readFile(inst.files[0], 'utf8'), 'user edit\n');
  });

  test(`${platform}: --plan install/remove write nothing and run nothing`, async t => {
    const f = await setup(t, platform);
    await commands.sync(['schedule', 'install', '--plan', '--interval', '5'], f.ctx);
    await commands.sync(['schedule', 'remove', '--plan'], f.ctx);
    assert.equal(f.calls.length, 0);
    await absent(join(f.paths.stateDir, 'sync'));
  });

  test(`${platform}: interval boundaries and bad input`, async t => {
    const f = await setup(t, platform);
    for (const bad of ['0', '1441', '-1', '1.5', 'abc', '']) {
      await assert.rejects(commands.sync(['schedule', 'install', '--interval', bad, '--plan'], f.ctx), undefined, `interval ${bad}`);
    }
    await assert.rejects(commands.sync(['schedule', 'status', '--interval', '5'], f.ctx));
    await assert.rejects(commands.sync(['schedule', 'bogus'], f.ctx));
    assert.equal((await commands.sync(['schedule', 'install', '--interval', '1', '--plan'], f.ctx)).intervalMin, 1);
    assert.equal((await commands.sync(['schedule', 'install', '--interval', '1440', '--plan'], f.ctx)).intervalMin, 1440);
  });
}

test('CLI uninstall with failing scheduler stop aborts, keeps scheduler files; retry succeeds', async t => {
  const platform = 'linux';
  const f = await setup(t, platform);
  const releaseDir = join(f.paths.releasesDir, 'sched-fixture');
  const mod = join(releaseDir, 'modules', 'sync-engine');
  const coreDir = resolve(sourceRoot, 'packages/core');
  await mkdir(dirname(mod), { recursive: true });
  await cp(resolve(sourceRoot, 'modules/sync-engine'), mod, { recursive: true });
  await mkdir(join(releaseDir, 'packages'), { recursive: true });
  await symlink(coreDir, join(releaseDir, 'packages/core'), 'dir');
  await mkdir(join(releaseDir, 'node_modules', '@brainatlas'), { recursive: true });
  await symlink(coreDir, join(releaseDir, 'node_modules', '@brainatlas/core'), 'dir');
  await symlink('releases/sched-fixture', f.paths.currentDir);
  await mkdir(dirname(f.paths.configFile), { recursive: true });
  const config = defaultConfig('full');
  config.modules = ['sync-engine'];
  config.vault.path = join(f.home, 'vault');
  await writeFile(f.paths.configFile, `${JSON.stringify(config, null, 2)}\n`);
  await writeFile(f.paths.installManifest, `${JSON.stringify({ schemaVersion: 1, files: [], createdDirectories: [] })}\n`);
  await mkdir(config.vault.path, { recursive: true });
  const invoke = async args => {
    const lines = []; const orig = console.log; console.log = v => lines.push(v);
    try { await main(args, f.env, { runCommand: f.ctx.runCommand }); } finally { console.log = orig; }
    return JSON.parse(lines.at(-1));
  };
  await invoke(['sync', 'schedule', 'install', '--json']);
  const dir = join(f.env.XDG_CONFIG_HOME, 'systemd', 'user');
  const timer = join(dir, 'brainatlas-sync.timer');
  const before = await readFile(timer);
  f.state.stop = { code: 1, stderr: 'denied' };
  await assert.rejects(invoke(['uninstall', '--json']), { code: 'E_SCHEDULER_COMMAND' });
  assert.deepEqual(await readFile(timer), before);
  await readFile(f.paths.configFile); // config not destroyed by aborted uninstall
  f.state.stop = { code: 0 };
  const out = await invoke(['uninstall', '--json']);
  assert.equal(out.scheduler.removed.length, 2);
  await absent(timer);
});

test('path escape: scheduler dir symlinked outside HOME is rejected without opt-in and nothing written outside', async t => {
  const f = await setup(t, 'linux');
  const outside = join(f.root, 'outside');
  await mkdir(outside, { recursive: true });
  await mkdir(join(f.home, 'config'), { recursive: true });
  await symlink(outside, join(f.home, 'config', 'systemd'), 'dir');
  await assert.rejects(commands.sync(['schedule', 'install'], f.ctx), { code: 'E_PATH_ESCAPE' });
  await assert.rejects(commands.sync(['schedule', 'remove'], f.ctx), { code: 'E_PATH_ESCAPE' });
  await absent(join(outside, 'user'));
  assert.equal(f.calls.length, 0);
});

test('path escape: ../ in XDG_CONFIG_HOME resolving outside HOME is rejected', async t => {
  const f = await setup(t, 'linux');
  f.env.XDG_CONFIG_HOME = join(f.home, '..', 'escaped-cfg');
  await assert.rejects(commands.sync(['schedule', 'install'], f.ctx), { code: 'E_PATH_ESCAPE' });
  await absent(join(f.root, 'escaped-cfg'));
});

test('unowned pre-existing unit file is not overwritten', async t => {
  const f = await setup(t, 'linux');
  const dir = join(f.env.XDG_CONFIG_HOME, 'systemd', 'user');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'brainatlas-sync.timer'), 'mine\n');
  await assert.rejects(commands.sync(['schedule', 'install'], f.ctx), { code: 'E_SCHEDULER_EXISTS' });
  assert.equal(await readFile(join(dir, 'brainatlas-sync.timer'), 'utf8'), 'mine\n');
  await absent(join(dir, 'brainatlas-sync.service'));
});
