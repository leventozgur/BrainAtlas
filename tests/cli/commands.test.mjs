// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('init, config, plan and doctor use an isolated HOME', async t => {
  const home = await mkdtemp(join(tmpdir(), 'ba-cli-')); t.after(() => rm(home, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, 'config'), XDG_DATA_HOME: join(home, 'data'), XDG_STATE_HOME: join(home, 'state'), BRAINATLAS_PLATFORM: 'linux', BRAINATLAS_OFFLINE: '1' };
  const run = (...args) => spawnSync(process.execPath, [resolve('packages/cli/bin/brainatlas.mjs'), ...args], { env, encoding: 'utf8' });
  assert.equal(run('init', '--yes', '--vault', join(home, 'vault')).status, 0);
  const file = join(home, 'config', 'brainatlas', 'config.json'); const before = await readFile(file, 'utf8');
  assert.equal(run('config', 'set', 'hooks.deadlineMs', '1234', '--plan').status, 0);
  assert.equal(await readFile(file, 'utf8'), before);
  assert.equal(run('config', 'set', 'hooks.deadlineMs', '1234').status, 0);
  assert.equal(JSON.parse(run('config', 'get', 'hooks.deadlineMs', '--json').stdout), 1234);
  assert.equal(run('config', 'set', 'safety.secretFilter', 'false').status, 1);
  const status = run('status', '--json'); assert.equal(status.status, 0); assert.equal(JSON.parse(status.stdout).checks.config, true);
  assert.equal(run('doctor', '--json').status, 1);
  assert.equal(JSON.parse(run('update', '--check', '--json').stdout).status, 'unknown');
});
