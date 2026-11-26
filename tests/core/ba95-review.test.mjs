// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONFIG_SCHEMA,
  defaultConfig,
  loadConfig,
  saveConfig,
  STANDARD_SCHEMA,
  STANDARD_VERSION,
  validateConfig,
  validateStandard,
  writeStandard,
} from '../../packages/core/src/index.mjs';

const standard = {
  standardVersion: STANDARD_VERSION,
  okf: { level: 'strict' },
  retrieval: { budgetChars: 1234, abstainThreshold: 0.5, exclude: ['drafts/**'] },
  safety: { extraDenyGlobs: ['private/**'] },
  capabilities: { minimum: { read: true, write: false } },
};

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'ba95-review-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const vault = join(base, 'vault');
  await mkdir(vault, { recursive: true });
  const configFile = join(base, 'config.json');
  const cfg = defaultConfig('lite');
  cfg.vault.path = vault;
  await writeFile(configFile, `${JSON.stringify(cfg, null, 2)}\n`);
  return { base, vault, configFile, paths: { configFile } };
}

test('the standard okf.level enum equals the device schema enum and off is rejected everywhere', () => {
  assert.deepEqual(
    STANDARD_SCHEMA.properties.okf.properties.level.enum,
    CONFIG_SCHEMA.properties.okf.properties.level.enum
  );
  assert.deepEqual(CONFIG_SCHEMA.properties.okf.properties.level.enum, ['warn', 'strict']);
  const cfg = defaultConfig('lite');
  cfg.okf.level = 'off';
  assert.equal(validateConfig(cfg).ok, false);
  assert.equal(validateStandard({ ...standard, okf: { level: 'off' } }).ok, false);
});

test('validateStandard enforces the device schema exclude item length', () => {
  const long = 'a'.repeat(201);
  const result = validateStandard({ ...standard, retrieval: { ...standard.retrieval, exclude: [long] } });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((item) => item.code === 'E_MAX_LENGTH'));
  assert.equal(
    validateStandard({ ...standard, retrieval: { ...standard.retrieval, exclude: ['a'.repeat(200)] } }).ok,
    true
  );
  assert.equal(CONFIG_SCHEMA.properties.retrieval.properties.exclude.items.maxLength, 200);
});

test('saveConfig persists a device key that equals the standard value and restores other vault keys', async (t) => {
  const f = await fixture(t);
  await writeStandard(f.vault, standard);
  const loaded = await loadConfig({ paths: f.paths, env: {} });
  assert.equal(loaded.okf.level, 'strict');
  loaded.okf.level = 'strict';
  await saveConfig(loaded, { paths: f.paths, deviceKeys: ['okf.level'] });
  const saved = JSON.parse(await readFile(f.configFile, 'utf8'));
  assert.equal(saved.okf.level, 'strict');
  assert.equal(saved.retrieval.budgetChars, defaultConfig('lite').retrieval.budgetChars);
  assert.equal(saved.retrieval.exclude, undefined);
  assert.deepEqual(saved.safety.extraDenyGlobs, defaultConfig('lite').safety.extraDenyGlobs);
});

test('saveConfig without device keys writes back the prior device values', async (t) => {
  const f = await fixture(t);
  await writeStandard(f.vault, standard);
  const loaded = await loadConfig({ paths: f.paths, env: {} });
  await saveConfig(loaded, { paths: f.paths });
  const saved = JSON.parse(await readFile(f.configFile, 'utf8'));
  assert.equal(saved.okf.level, defaultConfig('lite').okf.level);
});

test('standardApplied is a non-enumerable marker that is never persisted', async (t) => {
  const f = await fixture(t);
  await writeStandard(f.vault, standard);
  const loaded = await loadConfig({ paths: f.paths, env: {} });
  assert.equal(loaded.standardApplied, true);
  assert.equal(Object.keys(loaded).includes('standardApplied'), false);
  await saveConfig(loaded, { paths: f.paths });
  assert.equal('standardApplied' in JSON.parse(await readFile(f.configFile, 'utf8')), false);
});

test('saveConfig surfaces an unreadable device config instead of treating it as absent', async (t) => {
  const f = await fixture(t);
  await writeStandard(f.vault, standard);
  const loaded = await loadConfig({ paths: f.paths, env: {} });
  await rm(f.configFile);
  await mkdir(f.configFile);
  await assert.rejects(saveConfig(loaded, { paths: f.paths }), { code: 'E_CONFIG_READ' });
  await rm(f.configFile, { recursive: true });
  await saveConfig(loaded, { paths: f.paths });
  assert.equal(JSON.parse(await readFile(f.configFile, 'utf8')).okf.level, 'strict');
});
