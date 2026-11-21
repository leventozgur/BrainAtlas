// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultConfig, resolvePaths, saveConfig } from '@brainatlas/core';
import { cleanEnv } from './clean-env.mjs';

const root = resolve(join(fileURLToPath(new URL('.', import.meta.url)), '../..'));
const cli = join(root, 'packages', 'cli', 'bin', 'brainatlas.mjs');

function run(env, args) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, env, encoding: 'utf8', shell: false });
  assert.equal(result.error, undefined, result.error?.message || '');
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

async function fixture(t) {
  const temp = await mkdtemp(join(tmpdir(), 'ba62-summary-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const home = join(temp, 'home');
  const vault = join(temp, 'vault');
  const env = cleanEnv({
    PATH: process.env.PATH || '/usr/bin:/bin',
    TMPDIR: temp,
    HOME: home,
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_DATA_HOME: join(home, 'data'),
    XDG_STATE_HOME: join(home, 'state'),
    BRAINATLAS_PLATFORM: 'linux',
    BRAINATLAS_OFFLINE: '1',
  });
  const paths = resolvePaths({ platform: 'linux', env });
  const releaseDir = join(paths.releasesDir, 'ba62-fixture');
  await mkdir(releaseDir, { recursive: true });
  await symlink(join(root, 'packages'), join(releaseDir, 'packages'), 'dir');
  await symlink('releases/ba62-fixture', paths.currentDir, 'dir');
  await mkdir(join(vault, 'wiki', 'concepts'), { recursive: true });
  await writeFile(join(vault, 'wiki', 'concepts', 'a.md'), '# A\nSome page without metadata.\n');
  const config = defaultConfig('lite');
  config.vault.path = vault;
  await saveConfig(config, { paths });
  return { env, vault };
}

test('status --summary reports one health view without changing plain status', async (t) => {
  const f = await fixture(t);
  const plain = JSON.parse(run(f.env, ['status', '--json']));
  assert.equal(plain.currentVersion, 'ba62-fixture');
  assert.equal(plain.summary, undefined);

  const summary = JSON.parse(run(f.env, ['status', '--summary', '--json']));
  assert.equal(summary.version, 'ba62-fixture');
  assert.equal(summary.profile, 'lite');
  assert.equal(summary.semantic.enabled, false);
  assert.equal(summary.sync, null);
  assert.equal(typeof summary.okf.warnings, 'number');
  assert.equal(typeof summary.maintain.total, 'number');
  assert.equal(JSON.stringify(summary).includes(f.vault), false);

  const human = run(f.env, ['status', '--summary']);
  for (const label of ['Health', 'Version', 'Profile', 'Semantic', 'Sync', 'OKF', 'Maintain'])
    assert.match(human, new RegExp(`^${label}\\s`, 'm'));
  assert.equal(human.includes(f.vault), false);
});
