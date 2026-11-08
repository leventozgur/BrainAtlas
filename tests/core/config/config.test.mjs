// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig, loadConfig, migrateConfig, validateConfig } from '../../../packages/core/src/config/index.mjs';

test('defaults include an empty allow list and old v1 configs remain valid', () => {
  const fresh = defaultConfig('lite');
  assert.deepEqual(fresh.safety.allow, []);
  assert.equal(validateConfig(fresh).ok, true);
  delete fresh.safety.allow;
  assert.equal(validateConfig(fresh).ok, true);
});

test('allow fingerprints require canonical paths and match their finding channel', () => {
  const cfg = defaultConfig('custom');
  cfg.safety.allow = [{ path: 'wiki/concepts/page.md', ruleId: 'secret-assignment', sha256: 'a'.repeat(64) }];
  assert.equal(validateConfig(cfg).ok, true);
  for (const row of [
    { path: 'wiki/page.md', ruleId: 'secret-assignment' },
    { path: 'secret.md', ruleId: 'denied-path', sha256: 'b'.repeat(64) },
    { path: '../outside.md', ruleId: 'denied-path' },
    { path: 'wiki//page.md', ruleId: 'denied-path' },
  ]) {
    cfg.safety.allow = [row];
    assert.equal(validateConfig(cfg).ok, false);
  }
});

test('legacy migration adds an empty allow list while preserving its backup', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ba-safety-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const original = { profile: 'lite', vault: { path: 'vault' } };
  const migrated = await migrateConfig(original, { backupDir: dir, now: new Date('2026-01-02T03:04:05.000Z') });
  assert.deepEqual(migrated.config.safety.allow, []);
  assert.deepEqual(JSON.parse(await readFile(migrated.backupPath, 'utf8')), original);
});

test('read-only load migrates in memory without writing a backup or replacing the source', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ba-safety-plan-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configFile = join(dir, 'config.json');
  const original = '{"profile":"lite","vault":{"path":"vault"}}\n';
  await writeFile(configFile, original);
  const loaded = await loadConfig({ paths: { configFile }, env: { HOME: dir, XDG_CONFIG_HOME: join(dir, 'config') }, readOnly: true });
  assert.deepEqual(loaded.safety.allow, []);
  assert.equal(await readFile(configFile, 'utf8'), original);
  assert.deepEqual(await readdir(dir), ['config.json']);
});
