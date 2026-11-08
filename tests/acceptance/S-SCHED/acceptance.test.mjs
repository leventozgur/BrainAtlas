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

async function fixture(t, platform) {
  const root = await mkdtemp(join(tmpdir(), 's-sched-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  await mkdir(home, { recursive: true });
  const env = {
    HOME: home,
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_DATA_HOME: join(home, 'data'),
    XDG_STATE_HOME: join(home, 'state'),
    BRAINATLAS_PLATFORM: platform,
    UID: '4242',
    PATH: process.env.PATH || '/usr/bin:/bin',
  };
  const paths = resolvePaths({ platform, env });
  const calls = [];
  const runCommand = async (command, args, options) => {
    calls.push({ command, args, options });
    return { code: 0, stdout: '' };
  };
  return { root, home, env, paths, calls, ctx: { config: defaultConfig('full'), paths, env, runCommand } };
}

async function absent(path) {
  await assert.rejects(lstat(path), { code: 'ENOENT' });
}

test('macOS scheduler installs a matching LaunchAgent, reports status, and removes only its files', async t => {
  const f = await fixture(t, 'darwin');
  const target = join(f.home, 'Library', 'LaunchAgents', 'org.brainatlas.sync.plist');
  const installed = await commands.sync(['schedule', 'install', '--interval', '15'], f.ctx);
  assert.equal(installed.status, 'installed');
  assert.deepEqual(installed.files, [target]);
  const plist = await readFile(target, 'utf8');
  assert.match(plist, /<key>Label<\/key><string>org\.brainatlas\.sync<\/string>/);
  assert.equal(basenameWithoutExtension(target), 'org.brainatlas.sync');
  assert.match(plist, /<key>StartInterval<\/key><integer>900<\/integer>/);
  assert.match(plist, new RegExp(`<key>StandardOutPath</key><string>${escapeRegExp(join(f.paths.stateDir, 'sync', 'scheduler.log'))}</string>`));
  assert.match(plist, /<key>StandardErrorPath<\/key>/);
  assert.equal((await lstat(installed.logFile)).mode & 0o777, 0o600);
  assert.deepEqual(f.calls[0].args, ['bootstrap', 'gui/4242', target]);

  const status = await commands.sync(['schedule', 'status', '--json'], f.ctx);
  assert.equal(status.status, 'installed');
  assert.equal(status.loaded, true);
  assert.equal(f.calls.at(-1).args[0], 'print');

  const removed = await commands.sync(['schedule', 'remove'], f.ctx);
  assert.deepEqual(removed.removed, [target]);
  await absent(target);
  assert.deepEqual(f.calls.at(-1).args, ['bootout', 'gui/4242', target]);
});

test('Linux scheduler uses the XDG user units, reports status, and disables before cleanup', async t => {
  const f = await fixture(t, 'linux');
  const unitDir = join(f.env.XDG_CONFIG_HOME, 'systemd', 'user');
  const service = join(unitDir, 'brainatlas-sync.service');
  const timer = join(unitDir, 'brainatlas-sync.timer');
  const installed = await commands.sync(['schedule', 'install', '--interval=7'], f.ctx);
  assert.deepEqual(installed.files, [service, timer]);
  assert.match(await readFile(service, 'utf8'), /ExecStart=.*" sync run/);
  assert.match(await readFile(service, 'utf8'), /StandardOutput=append:/);
  assert.match(await readFile(timer, 'utf8'), /OnUnitActiveSec=7min/);
  assert.deepEqual(f.calls.map(call => call.args), [
    ['--user', 'daemon-reload'],
    ['--user', 'enable', '--now', 'brainatlas-sync.timer'],
  ]);

  const status = await commands.sync(['schedule', 'status'], f.ctx);
  assert.equal(status.status, 'installed');
  assert.equal(status.enabled, true);
  assert.equal(status.active, true);
  const removed = await commands.sync(['schedule', 'remove'], f.ctx);
  assert.deepEqual(removed.removed, [service, timer]);
  await absent(service); await absent(timer);
  assert.deepEqual(f.calls.slice(-2).map(call => call.args), [
    ['--user', 'disable', '--now', 'brainatlas-sync.timer'],
    ['--user', 'daemon-reload'],
  ]);
});

test('--plan performs no writes and an existing user scheduler file remains byte-identical', async t => {
  const f = await fixture(t, 'darwin');
  const target = join(f.home, 'Library', 'LaunchAgents', 'org.brainatlas.sync.plist');
  const plan = await commands.sync(['schedule', 'install', '--interval', '10', '--plan'], f.ctx);
  assert.equal(plan.intervalMin, 10);
  await absent(target);
  await absent(join(f.paths.stateDir, 'sync', 'scheduler.json'));
  const removePlan = await commands.sync(['schedule', 'remove', '--plan'], f.ctx);
  assert.deepEqual(removePlan.files, [target]);
  assert.equal(f.calls.length, 0);

  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, 'user-owned bytes\n', { mode: 0o600 });
  await assert.rejects(commands.sync(['schedule', 'install'], f.ctx), { code: 'E_SCHEDULER_EXISTS' });
  const removed = await commands.sync(['schedule', 'remove'], f.ctx);
  assert.deepEqual(removed.preserved, [target]);
  assert.equal(await readFile(target, 'utf8'), 'user-owned bytes\n');
  assert.equal(f.calls.length, 0);

  const changedFixture = await fixture(t, 'darwin');
  const managedTarget = join(changedFixture.home, 'Library', 'LaunchAgents', 'org.brainatlas.sync.plist');
  await commands.sync(['schedule', 'install'], changedFixture.ctx);
  await writeFile(managedTarget, 'user edit after install\n', { mode: 0o600 });
  const changedRemove = await commands.sync(['schedule', 'remove'], changedFixture.ctx);
  assert.deepEqual(changedRemove.preserved, [managedTarget]);
  assert.equal(await readFile(managedTarget, 'utf8'), 'user edit after install\n');

  const failedFixture = await fixture(t, 'linux');
  const failedCtx = { ...failedFixture.ctx, runCommand: async (command, args) => {
    failedFixture.calls.push({ command, args });
    return { code: args.includes('enable') ? 1 : 0 };
  } };
  await assert.rejects(commands.sync(['schedule', 'install'], failedCtx), { code: 'E_SCHEDULER_COMMAND' });
  await absent(join(failedFixture.env.XDG_CONFIG_HOME, 'systemd', 'user', 'brainatlas-sync.service'));
  await absent(join(failedFixture.env.XDG_CONFIG_HOME, 'systemd', 'user', 'brainatlas-sync.timer'));
  await absent(join(failedFixture.paths.stateDir, 'sync', 'scheduler.json'));
});

test('CLI uninstall removes an installed scheduler through the injected command runner', async t => {
  const f = await fixture(t, 'linux');
  const releaseDir = join(f.paths.releasesDir, 'sched-fixture');
  const installedModuleDir = join(releaseDir, 'modules', 'sync-engine');
  const coreDir = resolve(sourceRoot, 'packages/core');
  await mkdir(f.paths.releasesDir, { recursive: true });
  await mkdir(dirname(installedModuleDir), { recursive: true });
  await cp(resolve(sourceRoot, 'modules/sync-engine'), installedModuleDir, { recursive: true });
  await mkdir(join(releaseDir, 'packages'), { recursive: true });
  await symlink(coreDir, join(releaseDir, 'packages/core'), 'dir');
  await mkdir(join(releaseDir, 'node_modules', '@brainatlas'), { recursive: true });
  await symlink(coreDir, join(releaseDir, 'node_modules', '@brainatlas/core'), 'dir');
  await symlink('releases/sched-fixture', f.paths.currentDir);

  const configDir = dirname(f.paths.configFile);
  await mkdir(configDir, { recursive: true });
  const config = defaultConfig('full');
  config.modules = ['sync-engine'];
  config.vault.path = join(f.home, 'vault');
  await writeFile(f.paths.configFile, `${JSON.stringify(config, null, 2)}\n`);
  await writeFile(f.paths.installManifest, `${JSON.stringify({ schemaVersion: 1, files: [], createdDirectories: [] })}\n`);
  await mkdir(config.vault.path, { recursive: true });
  const target = join(f.env.XDG_CONFIG_HOME, 'systemd', 'user', 'brainatlas-sync.timer');
  const invoke = async args => {
    const lines = [];
    const originalLog = console.log;
    console.log = value => lines.push(value);
    try { await main(args, f.env, { runCommand: f.ctx.runCommand }); }
    finally { console.log = originalLog; }
    return JSON.parse(lines.at(-1));
  };
  const installed = await invoke(['sync', 'schedule', 'install', '--interval', '9', '--json']);
  assert.equal(installed.status, 'installed');
  assert.ok((await readFile(target, 'utf8')).includes('OnUnitActiveSec=9min'));
  assert.deepEqual(f.calls.slice(-2).map(call => call.args), [
    ['--user', 'daemon-reload'],
    ['--user', 'enable', '--now', 'brainatlas-sync.timer'],
  ]);
  assert.equal((await invoke(['sync', 'schedule', 'status', '--json'])).status, 'installed');

  const output = await invoke(['uninstall', '--json']);
  assert.deepEqual(output.scheduler.removed, [join(f.env.XDG_CONFIG_HOME, 'systemd', 'user', 'brainatlas-sync.service'), target]);
  await absent(target);
  assert.ok(f.calls.some(call => call.args.join(' ') === '--user disable --now brainatlas-sync.timer'));
});

function basenameWithoutExtension(path) { return path.slice(path.lastIndexOf('/') + 1).replace(/\.plist$/, ''); }
function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
