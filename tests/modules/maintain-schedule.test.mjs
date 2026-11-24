// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commands, planSchedule } from '../../modules/maintain-schedule/src/index.mjs';

const run = commands['maintain-schedule'];

async function fixture(t, platform) {
  const home = await mkdtemp(join(tmpdir(), 'maintain-schedule-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const calls = [];
  const ctx = {
    config: {},
    paths: { stateDir: join(home, 'state'), binPath: '/opt/brainatlas/bin/brainatlas' },
    env: { HOME: home, BRAINATLAS_PLATFORM: platform, UID: '501' },
    runCommand: async (command, args) => {
      calls.push([command, ...args]);
      return { code: 0, stdout: '' };
    },
  };
  return { home, ctx, calls };
}
const exists = (path) =>
  access(path).then(
    () => true,
    () => false
  );
const digest = (text) => createHash('sha256').update(text).digest('hex');
const statePathFor = (home) => join(home, 'state', 'maintain-schedule.json');
const readState = async (home) => JSON.parse(await readFile(statePathFor(home), 'utf8'));

test('plans a weekly launchd agent and a systemd user timer for maintain --weekly', () => {
  const mac = planSchedule({ platform: 'darwin', binPath: '/b/ba', home: '/h', day: 'tue', hour: 7 });
  assert.equal(mac.files.length, 1);
  assert.match(mac.files[0].path, /Library\/LaunchAgents\/org\.brainatlas\.maintain\.plist$/);
  assert.match(mac.files[0].contents, /<string>maintain<\/string><string>--weekly<\/string>/);
  assert.match(mac.files[0].contents, /<key>Weekday<\/key><integer>2<\/integer><key>Hour<\/key><integer>7<\/integer>/);
  const linux = planSchedule({ platform: 'linux', binPath: '/b/ba', home: '/h' });
  assert.deepEqual(
    linux.files.map((f) => f.path.split('/').pop()),
    ['brainatlas-maintain.service', 'brainatlas-maintain.timer']
  );
  assert.match(linux.files[0].contents, /ExecStart="\/b\/ba" maintain --weekly/);
  assert.match(linux.files[1].contents, /OnCalendar=Mon \*-\*-\* 09:00:00/);
  assert.throws(() => planSchedule({ platform: 'linux', binPath: '/b', home: '/h', hour: 24 }), /--hour/);
  assert.throws(() => planSchedule({ platform: 'linux', binPath: '/b', home: '/h', day: 'xyz' }), /--day/);
});

for (const platform of ['linux', 'darwin']) {
  test(`install, status and remove manage only their own files (${platform})`, async (t) => {
    const f = await fixture(t, platform);
    const plan = await run(['install', '--plan'], f.ctx);
    assert.equal(f.calls.length, 0);
    const [first] = plan.files;
    assert.equal(await exists(first.path), false);

    const installed = await run(['install', '--day', 'fri', '--hour', '8'], f.ctx);
    assert.equal(installed.status, 'installed');
    for (const path of installed.files) assert.equal(await exists(path), true);
    assert.ok(f.calls.some(([command]) => command === (platform === 'darwin' ? 'launchctl' : 'systemctl')));

    const status = await run(['status'], f.ctx);
    assert.equal(status.status, 'installed');
    assert.equal(status.day, 'fri');
    assert.equal(status.hour, 8);

    const removed = await run(['remove'], f.ctx);
    assert.equal(removed.removed.length, installed.files.length);
    assert.deepEqual(removed.preserved, []);
    for (const path of installed.files) assert.equal(await exists(path), false);
    assert.equal((await run(['status'], f.ctx)).status, 'not-installed');
  });
}

test('refuses to overwrite unmanaged files and preserves files edited after install', async (t) => {
  const f = await fixture(t, 'linux');
  const { files } = planSchedule({ platform: 'linux', binPath: f.ctx.paths.binPath, home: f.home });
  await mkdir(join(files[0].path, '..'), { recursive: true });
  await writeFile(files[0].path, 'user file\n');
  await assert.rejects(run(['install'], f.ctx), { code: 'E_SCHEDULER_EXISTS' });
  assert.equal(await readFile(files[0].path, 'utf8'), 'user file\n');

  await rm(files[0].path);
  const installed = await run(['install'], f.ctx);
  await writeFile(installed.files[0], 'edited by user\n');
  await assert.rejects(run(['install'], f.ctx), { code: 'E_SCHEDULER_CONFLICT' });
  const removed = await run(['remove'], f.ctx);
  assert.deepEqual(removed.preserved, [installed.files[0]]);
  assert.equal(await readFile(installed.files[0], 'utf8'), 'edited by user\n');
});

test('a failing first install removes the written files, the state and runs the remove commands', async (t) => {
  const f = await fixture(t, 'linux');
  f.ctx.runCommand = async (command, args) => {
    f.calls.push([command, ...args]);
    return { code: args.includes('enable') ? 1 : 0, stdout: '' };
  };
  await assert.rejects(run(['install'], f.ctx), { code: 'E_SCHEDULER_COMMAND' });
  const { files } = planSchedule({ platform: 'linux', binPath: f.ctx.paths.binPath, home: f.home });
  for (const file of files) assert.equal(await exists(file.path), false);
  assert.equal(await exists(statePathFor(f.home)), false);
  assert.ok(f.calls.some((call) => call.slice(1).join(' ') === '--user disable --now brainatlas-maintain.timer'));
});

test('a missing managed file refuses re-install with a conflict', async (t) => {
  const f = await fixture(t, 'linux');
  const installed = await run(['install'], f.ctx);
  await rm(installed.files[0]);
  await assert.rejects(run(['install', '--day', 'tue'], f.ctx), { code: 'E_SCHEDULER_CONFLICT' });
  assert.equal(await exists(installed.files[0]), false);
  assert.equal((await readState(f.home)).day, 'mon');
});

test('darwin re-install unloads before bootstrapping and records the new digests', async (t) => {
  const f = await fixture(t, 'darwin');
  const first = await run(['install', '--day', 'mon', '--hour', '9'], f.ctx);
  assert.equal(first.status, 'installed');
  f.calls.length = 0;

  const second = await run(['install', '--day', 'fri', '--hour', '18'], f.ctx);
  assert.equal(second.status, 'installed');
  const bootout = f.calls.findIndex(([command, action]) => command === 'launchctl' && action === 'bootout');
  const bootstrap = f.calls.findIndex(([command, action]) => command === 'launchctl' && action === 'bootstrap');
  assert.ok(bootout >= 0, 'bootout must be issued');
  assert.ok(bootstrap > bootout, 'bootout must precede bootstrap');
  assert.equal(f.calls[bootout][2], 'gui/501/org.brainatlas.maintain');

  const { files } = planSchedule({
    platform: 'darwin',
    binPath: f.ctx.paths.binPath,
    home: f.home,
    day: 'fri',
    hour: 18,
  });
  const state = await readState(f.home);
  assert.equal(state.day, 'fri');
  assert.equal(state.hour, 18);
  for (const file of files) {
    assert.equal(await readFile(file.path, 'utf8'), file.contents);
    assert.equal(digest(await readFile(file.path)), state.files.find((row) => row.path === file.path).sha256);
  }

  const removed = await run(['remove'], f.ctx);
  assert.deepEqual(removed.preserved, []);
  assert.equal(await exists(files[0].path), false);
  assert.equal(await exists(statePathFor(f.home)), false);
});

test('linux re-install reloads and restarts the timer for the new OnCalendar', async (t) => {
  const f = await fixture(t, 'linux');
  await run(['install', '--day', 'mon', '--hour', '9'], f.ctx);
  f.calls.length = 0;

  const second = await run(['install', '--day', 'wed', '--hour', '6'], f.ctx);
  assert.equal(second.status, 'installed');
  const commands = f.calls.map((call) => call.slice(1).join(' '));
  const reload = commands.indexOf('--user daemon-reload');
  const enable = commands.indexOf('--user enable --now brainatlas-maintain.timer');
  const restart = commands.indexOf('--user restart brainatlas-maintain.timer');
  assert.ok(reload >= 0, 'daemon-reload must be issued');
  assert.ok(enable > reload, 'enable must follow daemon-reload');
  assert.ok(restart > enable, 'restart must follow enable');

  const { files } = planSchedule({
    platform: 'linux',
    binPath: f.ctx.paths.binPath,
    home: f.home,
    day: 'wed',
    hour: 6,
  });
  assert.match(files[1].contents, /OnCalendar=Wed \*-\*-\* 06:00:00/);
  assert.equal(await readFile(files[1].path, 'utf8'), files[1].contents);
  const state = await readState(f.home);
  for (const file of files)
    assert.equal(digest(await readFile(file.path)), state.files.find((r) => r.path === file.path).sha256);
});

test('a failing bootstrap during re-install restores the previous plist and state', async (t) => {
  const f = await fixture(t, 'darwin');
  const first = await run(['install', '--day', 'mon', '--hour', '9'], f.ctx);
  const plistPath = first.files[0];
  const previousPlist = await readFile(plistPath);
  const previousState = await readFile(statePathFor(f.home));
  f.ctx.runCommand = async (command, args) => {
    f.calls.push([command, ...args]);
    return { code: args[0] === 'bootstrap' ? 1 : 0, stdout: '' };
  };

  await assert.rejects(run(['install', '--day', 'tue', '--hour', '7'], f.ctx), { code: 'E_SCHEDULER_COMMAND' });
  assert.deepEqual(await readFile(plistPath), previousPlist);
  assert.deepEqual(await readFile(statePathFor(f.home)), previousState);

  const removed = await run(['remove'], f.ctx);
  assert.deepEqual(removed.preserved, []);
  assert.equal(await exists(plistPath), false);
  assert.equal(await exists(statePathFor(f.home)), false);
});

test('a failing restart during linux re-install restores the units and re-enables the previous timer', async (t) => {
  const f = await fixture(t, 'linux');
  const first = await run(['install', '--day', 'mon', '--hour', '9'], f.ctx);
  const previous = await Promise.all(first.files.map((path) => readFile(path)));
  const previousState = await readFile(statePathFor(f.home));
  f.calls.length = 0;
  f.ctx.runCommand = async (command, args) => {
    f.calls.push([command, ...args]);
    return { code: args.includes('restart') ? 1 : 0, stdout: '' };
  };

  await assert.rejects(run(['install', '--day', 'tue', '--hour', '7'], f.ctx), { code: 'E_SCHEDULER_COMMAND' });
  for (const [index, path] of first.files.entries()) assert.deepEqual(await readFile(path), previous[index]);
  assert.deepEqual(await readFile(statePathFor(f.home)), previousState);
  const commands = f.calls.map((call) => call.slice(1).join(' '));
  assert.equal(commands.at(-1), '--user enable --now brainatlas-maintain.timer');
  assert.ok(commands.filter((line) => line === '--user daemon-reload').length >= 2);
});

test('systemd units escape % and $ in ExecStart arguments', () => {
  const binPath = '/srv/%h$HOME/bin/brainatlas';
  const { files } = planSchedule({ platform: 'linux', binPath, home: '/srv' });
  const exec = files[0].contents.match(/^ExecStart=(.*)$/m)[1];
  assert.match(exec, /%%h\$\$HOME/);
  const quoted = exec.match(/^"(.*)" maintain --weekly$/)[1];
  const unescaped = quoted.replaceAll('$$', '$').replaceAll('%%', '%').replaceAll('\\"', '"').replaceAll('\\\\', '\\');
  assert.equal(unescaped, binPath);
  assert.match(exec, /" maintain --weekly$/);
});

test('rejects bad arguments', async (t) => {
  const f = await fixture(t, 'linux');
  await assert.rejects(run(['bogus'], f.ctx), { code: 'E_ARGUMENT' });
  await assert.rejects(run(['status', '--plan'], f.ctx), { code: 'E_ARGUMENT' });
  await assert.rejects(run(['install', '--hour', 'x'], f.ctx), { code: 'E_ARGUMENT' });
});
