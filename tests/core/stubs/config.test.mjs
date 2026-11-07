// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as api from '../../../packages/core/src/config/index.mjs';

test('defaults validate for all profiles and Lite keeps modules empty', () => {
  for (const profile of ['lite','full','custom']) assert.equal(api.validateConfig(api.defaultConfig(profile)).ok, true);
  assert.deepEqual(api.defaultConfig('lite').modules, []);
  assert.deepEqual(api.defaultConfig('full').modules, ['*']);
});

test('validator gives key-specific errors without echoing values', () => {
  const cfg = api.defaultConfig('custom'); cfg.vault.path = 'TOP_SECRET_TOKEN'; cfg.extra = 'PRIVATE';
  const result = api.validateConfig(cfg);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((item) => item.path === 'extra' && item.code === 'E_ADDITIONAL_PROPERTY'));
  assert.ok(result.errors.every((item) => !item.message.includes('TOP_SECRET_TOKEN') && !item.message.includes('PRIVATE')));
  const disabled = api.defaultConfig('custom'); disabled.safety.secretFilter = false;
  assert.ok(api.validateConfig(disabled).errors.some((item) => item.code === 'E_LOCKED_KEY'));
});

test('Lite locked keys reject edits; allowed edits return a validated copy', () => {
  const cfg = api.defaultConfig('lite');
  assert.throws(() => api.setConfigValue(cfg, 'safety.secretFilter', false), { code: 'E_LOCKED_KEY' });
  assert.throws(() => api.setConfigValue(cfg, 'telemetry', true), { code: 'E_LOCKED_KEY' });
  const edited = api.setConfigValue(cfg, 'hooks.mode', 'manual');
  assert.equal(edited.hooks.mode, 'manual'); assert.equal(cfg.hooks.mode, 'normal');
});

test('load and atomic save round-trip config and reject invalid documents', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'brainatlas-config-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const paths = { configFile: join(dir, 'config.json') };
  const fresh = await api.loadConfig({ paths, env: { BRAINATLAS_PROFILE: 'lite' } });
  assert.equal(fresh.profile, 'lite');
  await api.saveConfig(fresh, { paths });
  assert.deepEqual(await api.loadConfig({ paths, env: {} }), fresh);
  await assert.rejects(api.saveConfig(fresh, { paths: { configFile: `${dir}/../escape.json` } }), { code: 'E_PATH_ESCAPE' });
  await (await import('node:fs/promises')).writeFile(paths.configFile, '{');
  await assert.rejects(api.loadConfig({ paths, env: {} }), { code: 'E_CONFIG_PARSE' });
});

test('migrations back up original config and support injected chains', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'brainatlas-migrate-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const old = { vault: { path: '/vault' } };
  const result = await api.migrateConfig(old, { backupDir: dir, now: new Date('2025-01-02T03:04:05.000Z') });
  assert.deepEqual(result.applied, ['000-to-1']); assert.equal(result.config.schemaVersion, 1);
  assert.deepEqual(JSON.parse(await readFile(result.backupPath, 'utf8')), old);
  let calls = 0;
  const fake = [
    { from: 0, to: 0.5, migrate: (obj) => { calls++; return obj; } },
    { from: 0.5, to: 1, migrate: () => { calls++; return api.defaultConfig('lite'); } }
  ];
  const chain = await api.migrateConfig(old, { backupDir: dir, now: new Date('2025-01-02T03:04:06.000Z'), migrations: fake });
  assert.deepEqual(chain.applied, ['000-to-0.5','0.5-to-1']); assert.equal(calls, 2);
});
