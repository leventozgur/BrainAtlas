// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultConfig, resolvePaths } from '@brainatlas/core';
import { cleanEnv } from '../../cli/clean-env.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const cli = join(root, 'packages/cli/bin/brainatlas.mjs');

async function fixture(t, label) {
  const temp = await mkdtemp(join(tmpdir(), `ba-i-initcfg-${label}-`));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const home = join(temp, 'home');
  await mkdir(home);
  const env = cleanEnv({
    HOME: home,
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_DATA_HOME: join(home, 'data'),
    XDG_STATE_HOME: join(home, 'state'),
    BRAINATLAS_PLATFORM: 'linux',
    BRAINATLAS_OFFLINE: '1',
    PATH: process.env.PATH || '/usr/bin:/bin'
  });
  const paths = resolvePaths({ platform: 'linux', env });
  const run = (...args) => spawnSync(process.execPath, [cli, ...args, '--json'], { cwd: root, env, encoding: 'utf8', shell: false, timeout: 20_000 });
  const config = async () => JSON.parse(await readFile(paths.configFile, 'utf8'));
  const writeConfig = async cfg => {
    await mkdir(dirname(paths.configFile), { recursive: true });
    await writeFile(paths.configFile, `${JSON.stringify(cfg, null, 2)}\n`);
  };
  const success = (args, label) => {
    const result = run(...args);
    assert.equal(result.error, undefined, `${label} could not start`);
    assert.equal(result.status, 0, `${label}: ${result.stderr}`);
    return JSON.parse(result.stdout);
  };
  return { temp, home, env, paths, run, config, writeConfig, success };
}

test('init --yes reuses the vault stored by install when --vault is omitted', async t => {
  const f = await fixture(t, 'installed-vault');
  const installedVault = join(f.temp, 'installed-vault');
  const cfg = defaultConfig('lite');
  cfg.vault.path = installedVault;
  await f.writeConfig(cfg);

  const result = f.success(['init', '--yes'], 'init using installed config');
  assert.equal(result.vault.path, installedVault);
  assert.equal((await f.config()).vault.path, installedVault);
  await assert.rejects(lstat(join(f.home, 'BrainAtlas')), { code: 'ENOENT' });
});

test('init --agents preserves sync and other settings byte-for-byte as JSON values', async t => {
  const f = await fixture(t, 'agents');
  const cfg = defaultConfig('full');
  cfg.vault.path = join(f.temp, 'vault');
  cfg.sync = { transport: 'git', options: { remote: 'https://example.com/repo', branch: 'main', hostId: 'fixture-host-id' } };
  cfg.okf.level = 'strict';
  cfg.hooks = { mode: 'economic', deadlineMs: 4321 };
  cfg.retrieval.budgetChars = 7654;
  cfg.modules = ['*'];
  await f.writeConfig(cfg);

  f.success(['init', '--yes', '--agents', 'agent-a'], 'init with agents');
  const after = await f.config();
  assert.deepEqual(after.sync, cfg.sync);
  assert.deepEqual(after.okf, cfg.okf);
  assert.deepEqual(after.hooks, cfg.hooks);
  assert.deepEqual(after.retrieval, cfg.retrieval);
  assert.deepEqual(after.modules, cfg.modules);
  assert.deepEqual(after.agents, ['agent-a']);
});

test('init --profile full changes only profile and profile modules', async t => {
  const f = await fixture(t, 'profile');
  const cfg = defaultConfig('custom');
  cfg.vault.path = join(f.temp, 'vault');
  cfg.modules = ['receipts'];
  cfg.agents = ['agent-a'];
  cfg.sync = { transport: 'folder', options: { remote: 'private-folder-reference', hostId: 'fixture-host-id' } };
  cfg.hooks.mode = 'manual';
  cfg.okf.level = 'strict';
  await f.writeConfig(cfg);

  const planned = f.success(['init', '--yes', '--profile', 'full', '--plan'], 'profile plan');
  assert.deepEqual(planned.config.changes, {
    profile: { from: 'custom', to: 'full' },
    modules: { from: ['receipts'], to: ['*'] }
  });
  assert.ok(!JSON.stringify(planned).includes(f.home));

  f.success(['init', '--yes', '--profile', 'full'], 'profile update');
  const after = await f.config();
  assert.equal(after.profile, 'full');
  assert.deepEqual(after.modules, ['*']);
  for (const key of Object.keys(cfg).filter(key => !['profile', 'modules'].includes(key))) assert.deepEqual(after[key], cfg[key], key);
});

test('init without an existing config retains default vault, profile, modules, and agents', async t => {
  const f = await fixture(t, 'defaults');
  const planned = f.success(['init', '--yes', '--plan'], 'default init plan');
  assert.equal(planned.vault.path, '~/BrainAtlas');
  assert.ok(planned.config.changes['vault.path'].to.includes('~/BrainAtlas'));
  f.success(['init', '--yes'], 'default init');
  const cfg = await f.config();
  assert.equal(cfg.vault.path, join(f.home, 'BrainAtlas'));
  assert.equal(cfg.profile, 'lite');
  assert.deepEqual(cfg.modules, []);
  assert.deepEqual(cfg.agents, []);
});
