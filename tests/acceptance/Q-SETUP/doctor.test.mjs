// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { defaultConfig, resolvePaths, saveConfig } from '@brainatlas/core';
import { main } from '../../../packages/cli/src/index.mjs';

const repo = resolve(new URL('../../..', import.meta.url).pathname);

async function doctorFixture(t, enabled) {
  const root = await mkdtemp(join(tmpdir(), 'q-setup-doctor-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const vault = join(root, 'vault');
  const wiki = join(vault, 'wiki');
  const env = {
    HOME: home,
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_DATA_HOME: join(home, 'data'),
    XDG_STATE_HOME: join(home, 'state'),
    BRAINATLAS_PLATFORM: 'linux',
    BRAINATLAS_OFFLINE: '1',
  };
  const paths = resolvePaths({ platform: 'linux', env });
  const releaseDir = join(paths.releasesDir, 'doctor-fixture');
  await Promise.all([mkdir(wiki, { recursive: true }), mkdir(join(releaseDir, 'modules'), { recursive: true })]);
  await writeFile(join(wiki, 'one.md'), '# A local page\n');
  await cp(resolve(repo, 'modules/semantic'), join(releaseDir, 'modules/semantic'), { recursive: true });
  await symlink(resolve(repo, 'packages'), join(releaseDir, 'packages'), 'dir');
  await symlink('releases/doctor-fixture', paths.currentDir, 'dir');
  const config = defaultConfig('custom');
  config.modules = ['semantic'];
  config.vault.path = vault;
  config.semantic.enabled = enabled;
  await saveConfig(config, { paths });
  return { root, home, paths, env };
}

async function runDoctor(fixture) {
  const lines = [];
  let networkCalls = 0;
  const originalLog = console.log;
  const originalError = console.error;
  const originalFetch = globalThis.fetch;
  const priorExitCode = process.exitCode;
  console.log = (...values) => lines.push(values.join(' '));
  console.error = (...values) => lines.push(values.join(' '));
  globalThis.fetch = async () => { networkCalls++; throw new Error('doctor must not use network'); };
  process.exitCode = 0;
  try { await main(['doctor', '--json'], fixture.env); }
  finally {
    console.log = originalLog;
    console.error = originalError;
    globalThis.fetch = originalFetch;
    process.exitCode = priorExitCode;
  }
  assert.equal(lines.length, 1);
  return { result: JSON.parse(lines[0]), networkCalls };
}

test('doctor omits the missing-index warning while semantic is disabled and stays networkless', async t => {
  const f = await doctorFixture(t, false);
  const { result, networkCalls } = await runDoctor(f);
  assert.deepEqual(Object.keys(result).sort(), ['checks', 'currentVersion', 'moduleHealth', 'modules', 'ok', 'profile', 'warnings'].sort());
  assert.equal(result.currentVersion, 'doctor-fixture');
  assert.deepEqual(result.checks, { config: true, release: true });
  assert.deepEqual(result.modules, ['semantic']);
  assert.deepEqual(result.moduleHealth, [{ name: 'semantic', enabled: false, freshness: null }], JSON.stringify(result));
  assert.ok(!result.warnings.includes('Semantic index is not available.'));
  assert.equal(networkCalls, 0);
});

test('doctor keeps the missing-index warning while semantic is enabled and preserves output keys', async t => {
  const f = await doctorFixture(t, true);
  const { result, networkCalls } = await runDoctor(f);
  assert.deepEqual(Object.keys(result).sort(), ['checks', 'currentVersion', 'moduleHealth', 'modules', 'ok', 'profile', 'warnings'].sort());
  assert.ok(result.warnings.includes('Semantic index is not available.'), JSON.stringify(result));
  assert.deepEqual(result.moduleHealth, [{ name: 'semantic', enabled: true, freshness: null }]);
  assert.equal(networkCalls, 0);
});
