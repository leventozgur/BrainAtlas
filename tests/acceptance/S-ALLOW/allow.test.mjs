// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig, loadConfig, resolvePaths, saveConfig } from '../../../packages/core/src/index.mjs';
import { main } from '../../../packages/cli/src/index.mjs';
import { inventoryVault } from '../../../modules/sync-engine/src/scope.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ba-allow-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const vault = join(root, 'vault');
  const env = {
    HOME: home,
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_DATA_HOME: join(home, 'data'),
    XDG_STATE_HOME: join(home, 'state'),
    BRAINATLAS_PLATFORM: 'linux',
  };
  await mkdir(join(vault, 'wiki', 'entities'), { recursive: true });
  const paths = resolvePaths({ platform: 'linux', env });
  const config = defaultConfig('lite');
  config.vault.path = vault;
  await saveConfig(config, { paths });
  return { env, paths, vault };
}

async function runCli(argv, env) {
  const output = [];
  const original = console.log;
  console.log = (line) => output.push(String(line));
  try { await main(argv, env); } finally { console.log = original; }
  assert.equal(output.length, 1, 'command should emit one result');
  return JSON.parse(output[0]);
}

test('CLI plan, allow, list, changed finding, revoke, and sync inventory stay value-free', async (t) => {
  const fx = await fixture(t);
  const path = 'wiki/entities/approved.md';
  const synthetic = 'S-ALLOW-initial-42AbCdEfGhIj';
  const initial = `# Note\nsecret: "${synthetic}"\n`;
  await writeFile(join(fx.vault, path), initial);
  const beforePlan = await readFile(fx.paths.configFile, 'utf8');

  const planned = await runCli(['safety', 'allow', path, '--plan', '--json'], fx.env);
  assert.equal(await readFile(fx.paths.configFile, 'utf8'), beforePlan);
  assert.deepEqual(Object.keys(planned.entries[0]).sort(), ['fingerprint', 'lineNumber', 'path', 'ruleId']);
  assert.equal(planned.entries[0].lineNumber, 2);
  assert.equal(JSON.stringify(planned).includes(synthetic), false);

  const allowed = await runCli(['safety', 'allow', path, '--json'], fx.env);
  assert.equal(JSON.stringify(allowed).includes(synthetic), false);
  const configAfterAllow = await loadConfig({ paths: fx.paths, env: fx.env });
  assert.equal(configAfterAllow.safety.allow.length, 1);
  assert.equal(Object.hasOwn(configAfterAllow.safety.allow[0], 'sha256'), true);
  assert.equal(JSON.stringify(configAfterAllow.safety.allow).includes(synthetic), false);
  const approvedInventory = await inventoryVault({ vaultPath: fx.vault, stateDir: join(fx.env.XDG_STATE_HOME, 'state'), config: configAfterAllow });
  assert.equal(approvedInventory.files.has(path), true);

  const listed = await runCli(['safety', 'list', path, '--json'], fx.env);
  assert.equal(listed.entries.length, 1);
  assert.deepEqual(Object.keys(listed.entries[0]).sort(), ['fingerprint', 'path', 'ruleId']);
  assert.equal(JSON.stringify(listed).includes(synthetic), false);

  const changed = `${initial}secret: "S-ALLOW-added-85KlMnOpQrSt"\n`;
  await writeFile(join(fx.vault, path), changed);
  const changedInventory = await inventoryVault({ vaultPath: fx.vault, stateDir: join(fx.env.XDG_STATE_HOME, 'state'), config: configAfterAllow });
  assert.equal(changedInventory.files.has(path), false);
  assert.ok(changedInventory.refused.some(row => row.path === path && row.ruleId === 'secret-assignment'));

  const plannedRevokeBefore = await readFile(fx.paths.configFile, 'utf8');
  const plannedRevoke = await runCli(['safety', 'revoke', path, '--plan', '--json'], fx.env);
  assert.equal(plannedRevoke.revoked, 1);
  assert.equal(await readFile(fx.paths.configFile, 'utf8'), plannedRevokeBefore);
  await runCli(['safety', 'revoke', path, '--json'], fx.env);
  const revokedConfig = await loadConfig({ paths: fx.paths, env: fx.env });
  assert.deepEqual(revokedConfig.safety.allow, []);
  const revokedInventory = await inventoryVault({ vaultPath: fx.vault, stateDir: join(fx.env.XDG_STATE_HOME, 'state'), config: revokedConfig });
  assert.equal(revokedInventory.files.has(path), false);
  assert.ok(revokedInventory.refused.some(row => row.path === path && row.ruleId === 'secret-assignment'));
});

test('path allowance stores only path and rule and does not disable content findings', async (t) => {
  const fx = await fixture(t);
  const config = await loadConfig({ paths: fx.paths, env: fx.env });
  config.sync.options.include = ['**/*'];
  await saveConfig(config, { paths: fx.paths });
  const path = '.env';
  await writeFile(join(fx.vault, path), 'MODE=example\n');

  const result = await runCli(['safety', 'allow', path, '--json'], fx.env);
  assert.deepEqual(Object.keys(result.entries[0]).sort(), ['fingerprint', 'path', 'ruleId']);
  assert.equal(result.entries[0].ruleId, 'denied-path');
  const afterAllow = await loadConfig({ paths: fx.paths, env: fx.env });
  assert.deepEqual(afterAllow.safety.allow, [{ path, ruleId: 'denied-path' }]);
  const allowedInventory = await inventoryVault({ vaultPath: fx.vault, stateDir: join(fx.env.XDG_STATE_HOME, 'state'), config: afterAllow });
  assert.equal(allowedInventory.files.has(path), true);

  await writeFile(join(fx.vault, path), 'secret: "S-ALLOW-content-46TuVwXyZaBc"\n');
  const contentInventory = await inventoryVault({ vaultPath: fx.vault, stateDir: join(fx.env.XDG_STATE_HOME, 'state'), config: afterAllow });
  assert.equal(contentInventory.files.has(path), false);
  assert.ok(contentInventory.refused.some(row => row.path === path && row.ruleId === 'secret-assignment'));
});
