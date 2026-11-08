// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { commands } from '../../../modules/sync-engine/src/index.mjs';

async function fixture(t, platform = 'linux') {
  const root = await mkdtemp(join(tmpdir(), 'sched-retest-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home'); await mkdir(home);
  const calls = [];
  const ctx = { env: { HOME: home, BRAINATLAS_PLATFORM: platform, UID: '1234' }, paths: { stateDir: join(home, 'state'), binPath: join(home, 'bin/brainatlas') }, runCommand: async (...args) => { calls.push(args); return { code: 0 }; } };
  return { root, home, ctx, calls, run: (...args) => commands.sync(['schedule', ...args], ctx) };
}

for (const platform of ['darwin', 'linux']) {
  test(`${platform}: outside directory requires explicit opt-in, then can be removed`, async t => {
    const f = await fixture(t, platform), outside = join(f.root, 'outside'); await mkdir(outside);
    const directory = platform === 'darwin' ? join(f.home, 'Library/LaunchAgents') : join(f.home, '.config/systemd/user');
    await mkdir(dirname(directory), { recursive: true }); await symlink(outside, directory);
    await assert.rejects(f.run('install'), { code: 'E_PATH_ESCAPE' });
    assert.deepEqual(await readdir(outside), []); assert.deepEqual(f.calls, []);
    f.ctx.env.BRAINATLAS_ALLOW_SYMLINKED_ROOT = '1';
    const installed = await f.run('install');
    assert.equal((await readdir(outside)).length, installed.files.length);
    await f.run('remove'); assert.deepEqual(await readdir(outside), []);
  });
  test(`${platform}: file symlink remains forbidden with opt-in`, async t => {
    const f = await fixture(t, platform), victim = join(f.root, 'victim'); await writeFile(victim, 'untouched');
    const plan = await f.run('install', '--plan'), target = plan.files[0].path;
    await mkdir(dirname(target), { recursive: true }); await symlink(victim, target);
    f.ctx.env.BRAINATLAS_ALLOW_SYMLINKED_ROOT = '1';
    await assert.rejects(f.run('install'), { code: 'E_PATH_ESCAPE' });
    assert.equal(await readFile(victim, 'utf8'), 'untouched'); assert.deepEqual(f.calls, []);
  });
  test(`${platform}: temporary scheduler file symlink must not overwrite outside HOME`, async t => {
    const f = await fixture(t, platform), victim = join(f.root, 'victim'); await writeFile(victim, 'untouched');
    const plan = await f.run('install', '--plan'), target = plan.files[0].path;
    await mkdir(dirname(target), { recursive: true }); await symlink(victim, `${target}.tmp-${process.pid}`);
    await f.run('install').catch(() => {});
    assert.equal(await readFile(victim, 'utf8'), 'untouched');
  });
}

test('XDG path traversal outside HOME is rejected before invoking runner', async t => {
  const f = await fixture(t); f.ctx.env.XDG_CONFIG_HOME = join(f.home, '../outside');
  await assert.rejects(f.run('install'), { code: 'E_PATH_ESCAPE' });
  await assert.rejects(lstat(join(f.root, 'outside')), { code: 'ENOENT' });
  assert.deepEqual(f.calls, []);
});
