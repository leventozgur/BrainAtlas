// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commands } from '../../../modules/sync-engine/src/index.mjs';

for (const platform of ['darwin', 'linux']) {
  test(`${platform}: failed scheduler stop preserves ownership and supports retry`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'sched-stop-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const home = join(root, 'home');
    await mkdir(home);
    let failStop = false;
    const calls = [];
    const ctx = {
      env: { HOME: home, BRAINATLAS_PLATFORM: platform, UID: '1234' },
      paths: { stateDir: join(home, 'state'), binPath: join(home, 'bin/brainatlas') },
      runCommand: async (cmd, args) => {
        calls.push([cmd, args]);
        return { code: failStop && (args.includes('bootout') || args.includes('disable')) ? 1 : 0 };
      },
    };
    const run = (...args) => commands.sync(['schedule', ...args], ctx);
    const installed = await run('install');
    const before = await Promise.all(installed.files.map(file => readFile(file)));
    failStop = true;
    await assert.rejects(run('remove'), { code: 'E_SCHEDULER_COMMAND' });
    for (let i = 0; i < installed.files.length; i++) assert.deepEqual(await readFile(installed.files[i]), before[i]);
    assert.equal((await run('status')).status, 'installed');
    failStop = false;
    await run('remove');
    assert.equal((await run('status')).status, 'not-installed');
    assert.equal(calls.filter(([, args]) => args.includes(platform === 'darwin' ? 'bootout' : 'disable')).length, 2);
  });
}

