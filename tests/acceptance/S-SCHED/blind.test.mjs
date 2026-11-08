// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, lstat, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { commands } from '../../../modules/sync-engine/src/index.mjs';

async function fixture(t, platform) {
  const root = await mkdtemp(join(tmpdir(), 'sched-blind-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home'); await mkdir(home);
  const calls = [];
  const ctx = { env: { HOME: home, BRAINATLAS_PLATFORM: platform, UID: '1234' }, paths: { stateDir: join(home, 'state'), binPath: join(home, 'bin', 'brainatlas') }, runCommand: async (cmd, args) => { calls.push([cmd, args]); return { code: 0, stdout: '' }; } };
  return { root, home, calls, ctx, run: (...args) => commands.sync(['schedule', ...args], ctx) };
}
async function absent(path) { await assert.rejects(lstat(path), { code: 'ENOENT' }); }

for (const platform of ['darwin', 'linux']) {
  test(`${platform}: install, status, remove and foreign files`, async t => {
    const f = await fixture(t, platform);
    const before = await f.run('status', '--json');
    assert.equal(before.status, 'not-installed');
    f.calls.length = 0;
    const installed = await f.run('install', '--interval', '17', '--json');
    assert.equal(installed.intervalMin, 17);
    const files = installed.files;
    const log = join(f.home, 'state', 'sync', 'scheduler.log');
    assert.equal(installed.logFile, log);
    assert.equal((await lstat(log)).mode & 0o777, 0o600);
    if (platform === 'darwin') {
      assert.deepEqual(files, [join(f.home, 'Library/LaunchAgents/org.brainatlas.sync.plist')]);
      const plist = await readFile(files[0], 'utf8');
      assert.match(plist, /<key>Label<\/key><string>org\.brainatlas\.sync<\/string>/);
      assert.equal(basename(files[0], '.plist'), 'org.brainatlas.sync');
      assert.match(plist, /<key>StartInterval<\/key><integer>1020<\/integer>/);
      assert.ok(plist.includes(`<string>${f.ctx.paths.binPath}</string><string>sync</string><string>run</string>`));
      assert.equal(plist.split(log).length - 1, 2);
      assert.deepEqual(f.calls, [['launchctl', ['bootstrap', 'gui/1234', files[0]]]]);
    } else {
      assert.deepEqual(files, [join(f.home, '.config/systemd/user/brainatlas-sync.service'), join(f.home, '.config/systemd/user/brainatlas-sync.timer')]);
      assert.match(await readFile(files[0], 'utf8'), /ExecStart=".*brainatlas" sync run/);
      assert.match(await readFile(files[1], 'utf8'), /OnUnitActiveSec=17min/);
      assert.ok((await readFile(files[0], 'utf8')).includes(log));
      assert.deepEqual(f.calls, [['systemctl', ['--user', 'daemon-reload']], ['systemctl', ['--user', 'enable', '--now', 'brainatlas-sync.timer']]]);
    }
    const status = await f.run('status', '--json');
    assert.equal(status.status, 'installed'); assert.equal(status.intervalMin, 17);
    const foreign = join(f.home, platform === 'darwin' ? 'Library/LaunchAgents/com.example.legacy.plist' : '.config/systemd/user/foreign.timer');
    await writeFile(foreign, 'keep');
    f.calls.length = 0;
    await f.run('remove');
    for (const file of files) await absent(file);
    assert.equal(await readFile(foreign, 'utf8'), 'keep');
    assert.deepEqual(f.calls[0], platform === 'darwin' ? ['launchctl', ['bootout', 'gui/1234', files[0]]] : ['systemctl', ['--user', 'disable', '--now', 'brainatlas-sync.timer']]);
    assert.equal((await f.run('status')).status, 'not-installed');
  });
  test(`${platform}: plan is read-only, input bounds and invalid arguments`, async t => {
    const f = await fixture(t, platform);
    for (const n of [1, 1440]) assert.equal((await f.run('install', '--interval', String(n), '--plan')).intervalMin, n);
    assert.equal((await f.run('remove', '--plan')).action, 'remove');
    for (const args of [['install', '--interval', '0'], ['install', '--interval', '1441'], ['install', '--interval', '1.5'], ['install', '--interval', 'NaN'], ['install', '--interval'], ['status', '--plan'], ['remove', '--interval', '2'], ['wat']]) await assert.rejects(f.run(...args));
    assert.deepEqual(await readdir(f.home), []); assert.deepEqual(f.calls, []);
  });
  test(`${platform}: protects existing and modified user files`, async t => {
    const f = await fixture(t, platform);
    const plan = await f.run('install', '--plan');
    const target = plan.files[0].path;
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, 'user data');
    await assert.rejects(f.run('install'), { code: 'E_SCHEDULER_EXISTS' });
    assert.equal(await readFile(target, 'utf8'), 'user data');
    await f.run('remove'); assert.equal(await readFile(target, 'utf8'), 'user data');
    await rm(target); await f.run('install');
    await writeFile(target, 'user edit');
    await assert.rejects(f.run('install'), { code: 'E_SCHEDULER_CONFLICT' });
    const result = await f.run('remove'); assert.ok(result.preserved.includes(target));
    assert.equal(await readFile(target, 'utf8'), 'user edit');
  });
  test(`${platform}: runner failure rolls back without leaking runner output`, async t => {
    const f = await fixture(t, platform); const secret = ['sk', 'test' + 'x'.repeat(24)].join('-');
    const calls = [];
    f.ctx.runCommand = async (cmd, args) => { calls.push([cmd, args]); return { code: 1, stdout: secret, stderr: secret }; };
    let failure; try { await f.run('install'); } catch (e) { failure = e; }
    assert.equal(failure?.code, 'E_SCHEDULER_COMMAND'); assert.ok(!String(failure.stack).includes(secret));
    const plan = await f.run('install', '--plan'); for (const file of plan.files) await absent(file.path);
    await absent(join(f.home, 'state/sync/scheduler.log'));
    assert.ok(calls.some(([, args]) => args.includes(platform === 'darwin' ? 'bootout' : 'disable')));
    const status = await f.run('status', '--json'); assert.ok(!JSON.stringify(status).includes(secret));
  });
  test(`${platform}: symlink log is rejected without modifying its target`, async t => {
    const f = await fixture(t, platform); const outside = join(f.root, 'outside'); await writeFile(outside, 'sentinel');
    const sync = join(f.home, 'state/sync'); await mkdir(sync, { recursive: true }); await symlink(outside, join(sync, 'scheduler.log'));
    await assert.rejects(f.run('install')); assert.equal(await readFile(outside, 'utf8'), 'sentinel'); assert.ok(f.calls.every(([, args]) => !args.includes('enable') && !args.includes('bootstrap')));
  });
  test(`${platform}: scheduler directories cannot redirect writes through symlinks`, async t => {
    const f = await fixture(t, platform); const outside = join(f.root, 'outside'); await mkdir(outside);
    if (platform === 'darwin') { await mkdir(join(f.home, 'Library')); await symlink(outside, join(f.home, 'Library/LaunchAgents')); }
    else { await mkdir(join(f.home, '.config/systemd'), { recursive: true }); await symlink(outside, join(f.home, '.config/systemd/user')); }
    await assert.rejects(f.run('install'));
    assert.deepEqual(await readdir(outside), []); assert.deepEqual(f.calls, []);
  });
}

test('manifest path traversal is rejected and outside files remain untouched', async t => {
  const f = await fixture(t, 'linux'); const outside = join(f.root, 'outside'); await writeFile(outside, 'sentinel');
  const state = join(f.home, 'state/sync'); await mkdir(state, { recursive: true });
  await writeFile(join(state, 'scheduler.json'), JSON.stringify({ schemaVersion: 1, files: [{ path: join(f.home, '../outside'), sha256: 'a'.repeat(64), mode: 0o600 }] }));
  await assert.rejects(f.run('remove'), { code: 'E_STATE_INVALID' });
  assert.equal(await readFile(outside, 'utf8'), 'sentinel'); assert.deepEqual(f.calls, []);
});
