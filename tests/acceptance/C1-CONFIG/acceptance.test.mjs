// SPDX-License-Identifier: MIT
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultConfig, validateConfig, loadConfig, saveConfig, setConfigValue, migrateConfig } from '../../../packages/core/src/config/index.mjs';
import { resolvePaths, vaultId } from '../../../packages/core/src/paths/index.mjs';
import { readModuleManifest, discoverModules, resolveModuleOrder, activate } from '../../../packages/core/src/modules/index.mjs';

async function fixture(t) { const dir = await mkdtemp(join(os.tmpdir(), 'c1-config-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }
const code = (expected) => (error) => error.code === expected;
const manifest = (name, requires = [], profiles = ['full']) => ({ name, version: '1', description: 'test', requires, provides: [], profiles, entry: 'index.mjs' });

test('config schema rejects malformed values without echoing secret values', () => {
  for (const profile of ['lite', 'full', 'custom']) {
    const cfg = defaultConfig(profile);
    assert.equal(validateConfig(cfg).ok, true);
    cfg.safety.secretFilter = false;
    assert.equal(validateConfig(cfg).ok, false);
    assert.throws(() => setConfigValue(defaultConfig(profile), 'safety.secretFilter', false), code('E_LOCKED_KEY'));
  }
  const cases = [
    [c => { c.readOnly = 'secret-token-123'; }, 'readOnly', 'E_TYPE'],
    [c => { c.unexpected = 'secret-token-123'; }, 'unexpected', 'E_ADDITIONAL_PROPERTY'],
    [c => { delete c.vault.path; }, 'vault.path', 'E_REQUIRED'],
    [c => { c.retrieval.budgetChars = 0; }, 'retrieval.budgetChars', 'E_MINIMUM'],
    [c => { c.retrieval.abstainThreshold = 1.01; }, 'retrieval.abstainThreshold', 'E_MAXIMUM'],
    [c => { c.modules = ['x', 'x']; }, 'modules', 'E_UNIQUE']
  ];
  for (const [mutate, path, errorCode] of cases) {
    const cfg = defaultConfig('lite'); mutate(cfg); const result = validateConfig(cfg);
    assert.equal(result.ok, false); assert.ok(result.errors.some(e => e.path === path && e.code === errorCode));
    assert.ok(!JSON.stringify(result).includes('secret-token-123'));
  }
  const boundary = defaultConfig('custom'); boundary.retrieval.budgetChars = 1; boundary.retrieval.abstainThreshold = 0; assert.equal(validateConfig(boundary).ok, true);
  boundary.retrieval.abstainThreshold = 1; assert.equal(validateConfig(boundary).ok, true);
});

test('Lite locked keys reject changes and permit their locked values', () => {
  const cfg = defaultConfig('lite');
  for (const [key, good, bad] of [['safety.secretFilter', true, false], ['telemetry', false, true]]) {
    assert.deepEqual(setConfigValue(cfg, key, good), cfg);
    assert.throws(() => setConfigValue(cfg, key, bad), code('E_LOCKED_KEY'));
  }
  assert.throws(() => setConfigValue(cfg, '../secret-token-123', 'x'), code('E_CONFIG_KEY'));
});

test('platform path tables use injected HOME and XDG values only', () => {
  const original = os.homedir; os.homedir = () => { throw new Error('real HOME accessed'); };
  try {
    const home = '/tmp/c1-fake-home';
    for (const platform of ['darwin', 'linux']) assert.throws(() => resolvePaths({ platform, env: {} }), code('E_NO_HOME'));
    const mac = resolvePaths({ platform: 'darwin', env: { HOME: home, XDG_DATA_HOME: '/tmp/ignored' } });
    assert.equal(mac.dataDir, `${home}/Library/Application Support/BrainAtlas`);
    assert.equal(mac.configFile, `${mac.dataDir}/config.json`); assert.equal(mac.stateDir, `${mac.dataDir}/state`);
    const linux = resolvePaths({ platform: 'linux', env: { HOME: home } });
    assert.equal(linux.dataDir, `${home}/.local/share/brainatlas`); assert.equal(linux.configFile, `${home}/.config/brainatlas/config.json`); assert.equal(linux.stateDir, `${home}/.local/state/brainatlas`);
    const xdg = resolvePaths({ platform: 'linux', env: { HOME: home, XDG_DATA_HOME: '/tmp/data', XDG_CONFIG_HOME: '/tmp/config', XDG_STATE_HOME: '/tmp/state' } });
    assert.equal(xdg.dataDir, '/tmp/data/brainatlas'); assert.equal(xdg.configFile, '/tmp/config/brainatlas/config.json'); assert.equal(xdg.stateDir, '/tmp/state/brainatlas');
    for (const paths of [mac, linux, xdg]) { assert.equal(paths.releasesDir, `${paths.dataDir}/releases`); assert.equal(paths.binPath, `${paths.dataDir}/bin/brainatlas`); assert.equal(paths.currentDir, `${paths.dataDir}/current`); assert.equal(paths.installManifest, `${paths.dataDir}/install-manifest.json`); }
  } finally { os.homedir = original; }
});

test('vault IDs are stable 16 hex digits and require absolute paths', () => {
  assert.match(vaultId('/tmp/a'), /^[0-9a-f]{16}$/); assert.equal(vaultId('/tmp/a'), vaultId('/tmp/a')); assert.notEqual(vaultId('/tmp/a'), vaultId('/tmp/b'));
  for (const p of ['', 'relative', null]) assert.throws(() => vaultId(p), code('E_VAULT_PATH'));
});

test('save/load reject invalid content and traversal; failed rename cleans temporary files', async t => {
  const dir = await fixture(t); const file = join(dir, 'config.json'); const paths = { configFile: file }; const cfg = defaultConfig('lite');
  await saveConfig(cfg, { paths }); assert.deepEqual(await loadConfig({ paths, env: {} }), cfg); assert.deepEqual(await readdir(dir), ['config.json']);
  await assert.rejects(saveConfig(cfg, { paths: { configFile: `${dir}/../escape.json` } }), code('E_PATH_ESCAPE'));
  await writeFile(file, '{secret-token-123'); await assert.rejects(loadConfig({ paths, env: {} }), e => e.code === 'E_CONFIG_PARSE' && !e.message.includes('secret-token-123'));
  const invalid = defaultConfig('lite'); invalid.readOnly = 'secret-token-123'; await assert.rejects(saveConfig(invalid, { paths }), e => e.code === 'E_CONFIG_INVALID' && !JSON.stringify(e).includes('secret-token-123'));
  const target = join(dir, 'directory'); await mkdir(target); await assert.rejects(saveConfig(cfg, { paths: { configFile: target } }), code('E_CONFIG_WRITE')); assert.ok(!(await readdir(dir)).some(n => n.endsWith('.tmp')));
});

test('migration advances, supports chains and rejects unknown future versions', async t => {
  const dir = await fixture(t); const old = { schemaVersion: 0, profile: 'lite' }; const now = new Date('2025-01-02T03:04:05Z');
  const result = await migrateConfig(old, { backupDir: dir, now }); assert.equal(result.config.schemaVersion, 1); assert.deepEqual(result.applied, ['000-to-1']); assert.deepEqual(JSON.parse(await readFile(result.backupPath, 'utf8')), old);
  const chain = await migrateConfig({ schemaVersion: -1 }, { backupDir: dir, now: new Date('2025-01-02T03:04:06Z'), migrations: [{ from: -1, to: 0, migrate: x => x }, { from: 0, to: 1, migrate: () => defaultConfig('lite') }] }); assert.equal(chain.applied.length, 2);
  await assert.rejects(migrateConfig({ ...defaultConfig('lite'), schemaVersion: 2 }, { backupDir: dir }), code('E_CONFIG_INVALID'));
  await assert.rejects(migrateConfig(old, { migrations: [] }), code('E_MIGRATION_MISSING'));
});

test('migration backup preserves original file bytes', async t => {
  const dir = await fixture(t); const original = '{"schemaVersion":0,"profile":"lite"}\n';
  const result = await migrateConfig(JSON.parse(original), { backupDir: dir, now: new Date('2025-01-02T03:04:05Z') });
  assert.equal(await readFile(result.backupPath, 'utf8'), original);
});

test('module discovery, dependency order, invalid manifest and cycles', async t => {
  const dir = await fixture(t); const modules = join(dir, 'modules');
  for (const m of [manifest('consumer', ['foundation']), manifest('foundation'), manifest('custom', [], ['custom'])]) { const d = join(modules, m.name); await mkdir(d, { recursive: true }); await writeFile(join(d, 'module.json'), JSON.stringify(m)); }
  const found = await discoverModules(dir); assert.deepEqual(found.filter(m => m.profiles.includes('full')).map(m => m.name), ['consumer', 'foundation']);
  assert.deepEqual(defaultConfig('full').modules, ['*']); assert.deepEqual(defaultConfig('lite').modules, []);
  const order = resolveModuleOrder(found).map(m => m.name); assert.ok(order.indexOf('foundation') < order.indexOf('consumer'));
  assert.throws(() => resolveModuleOrder([manifest('a', ['b']), manifest('b', ['a'])]), code('E_MODULE_CYCLE'));
  assert.throws(() => resolveModuleOrder([manifest('a', ['missing'])]), code('E_MODULE_DEPENDENCY'));
  await writeFile(join(modules, 'custom', 'module.json'), '{bad'); await assert.rejects(discoverModules(dir), code('E_MODULE_MANIFEST'));
  await writeFile(join(modules, 'custom', 'module.json'), JSON.stringify({ ...manifest('custom'), entry: '../outside.mjs' })); assert.throws(() => readModuleManifest(join(modules, 'custom')), code('E_MODULE_MANIFEST'));
});

test('module activation rejects symlink escape', async t => {
  const dir = await fixture(t); const mod = join(dir, 'module'); await mkdir(mod); await writeFile(join(dir, 'outside.mjs'), 'export async function activate() {}'); await symlink(join(dir, 'outside.mjs'), join(mod, 'index.mjs'));
  await assert.rejects(activate({ moduleDir: mod, manifest: manifest('test') }), code('E_MODULE_ENTRY'));
});
