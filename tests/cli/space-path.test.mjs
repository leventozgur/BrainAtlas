// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { cleanEnv } from './clean-env.mjs';

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('CLI finds adapters under a space-containing install path and redacts plan secrets', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'ba cli space-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const install = join(temp, 'installed release');
  const home = join(temp, 'fake home');
  await mkdir(join(install, 'packages'), { recursive: true });
  await mkdir(home, { recursive: true });
  await cp(join(sourceRoot, 'packages/cli'), join(install, 'packages/cli'), { recursive: true });
  await cp(join(sourceRoot, 'packages/adapters'), join(install, 'packages/adapters'), { recursive: true });
  await symlink(join(sourceRoot, 'node_modules'), join(install, 'node_modules'), 'dir');

  const secret = ['ba', 'cli', randomBytes(24).toString('hex')].join('-');
  const settings = join(home, '.claude', 'settings.json');
  await mkdir(dirname(settings), { recursive: true });
  await writeFile(settings, `${JSON.stringify({ userSettings: { token: secret } }, null, 2)}\n`);
  const env = cleanEnv({
    PATH: process.env.PATH || '/usr/bin:/bin',
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    BRAINATLAS_PLATFORM: 'linux',
    BRAINATLAS_OFFLINE: '1'
  });
  const cli = join(install, 'packages/cli/bin/brainatlas.mjs');
  const result = spawnSync(process.execPath, [cli, 'init', '--yes', '--vault', join(home, 'vault'), '--agents', 'claude-code', '--plan', '--json'], {
    cwd: temp, env, encoding: 'utf8', shell: false
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.warnings, []);
  assert.ok(report.adapters.length > 0);
  const rendered = JSON.stringify(report.adapters);
  assert.ok(!rendered.includes(secret));
  assert.match(rendered, /REDACTED/);
  assert.equal(await readFile(settings, 'utf8'), `${JSON.stringify({ userSettings: { token: secret } }, null, 2)}\n`);
});
