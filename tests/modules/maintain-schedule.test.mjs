// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
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

test('a failing host command rolls back the written files', async (t) => {
  const f = await fixture(t, 'linux');
  f.ctx.runCommand = async (command, args) => {
    f.calls.push([command, ...args]);
    return { code: args.includes('enable') ? 1 : 0, stdout: '' };
  };
  await assert.rejects(run(['install'], f.ctx), { code: 'E_SCHEDULER_COMMAND' });
  const { files } = planSchedule({ platform: 'linux', binPath: f.ctx.paths.binPath, home: f.home });
  for (const file of files) assert.equal(await exists(file.path), false);
});

test('rejects bad arguments', async (t) => {
  const f = await fixture(t, 'linux');
  await assert.rejects(run(['bogus'], f.ctx), { code: 'E_ARGUMENT' });
  await assert.rejects(run(['status', '--plan'], f.ctx), { code: 'E_ARGUMENT' });
  await assert.rejects(run(['install', '--hour', 'x'], f.ctx), { code: 'E_ARGUMENT' });
});
