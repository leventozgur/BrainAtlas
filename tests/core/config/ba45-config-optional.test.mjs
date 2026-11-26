// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { defaultConfig, setConfigValue, unsetConfigValue } from '../../../packages/core/src/config/index.mjs';

const code = (expected) => (error) => error.code === expected;

test('setConfigValue creates absent optional keys and missing schema objects', () => {
  const cfg = defaultConfig('lite');
  const disclosure = setConfigValue(cfg, 'hooks.disclosure', 'progressive');
  assert.equal(disclosure.hooks.disclosure, 'progressive');
  assert.equal(cfg.hooks.disclosure, undefined);
  const exclude = setConfigValue(cfg, 'retrieval.exclude', ['drafts/**']);
  assert.deepEqual(exclude.retrieval.exclude, ['drafts/**']);
  const shadow = setConfigValue(cfg, 'retrieval.shadow.abstainThreshold', 0.5);
  assert.deepEqual(shadow.retrieval.shadow, { abstainThreshold: 0.5 });
});

test('setConfigValue rejects keys the schema does not define and keeps the input intact', () => {
  const cfg = defaultConfig('lite');
  const snapshot = JSON.stringify(cfg);
  for (const key of ['hooks.nope', 'retrieval.nope', 'vault.path.extra', 'notAKey', 'hooks.disclosure.extra']) {
    assert.throws(() => setConfigValue(cfg, key, 'x'), code('E_CONFIG_KEY'), key);
  }
  const withShadow = setConfigValue(cfg, 'retrieval.shadow.abstainThreshold', 0.5);
  assert.throws(() => setConfigValue(withShadow, 'retrieval.shadow.extra', 1), code('E_CONFIG_KEY'));
  const withRemote = setConfigValue(cfg, 'sync.options.remote', 'https://example.com/repo');
  assert.equal(withRemote.sync.options.remote, 'https://example.com/repo');
  assert.equal(JSON.stringify(cfg), snapshot);
});

test('setConfigValue validates known optional keys before returning', () => {
  const cfg = defaultConfig('lite');
  assert.throws(() => setConfigValue(cfg, 'hooks.disclosure', 'maybe'), code('E_CONFIG_INVALID'));
  assert.throws(() => setConfigValue(cfg, 'retrieval.exclude', 'x'), code('E_CONFIG_INVALID'));
  assert.throws(() => setConfigValue(cfg, 'retrieval.exclude', ['/abs']), code('E_CONFIG_INVALID'));
  assert.throws(() => setConfigValue(cfg, 'hooks.disclosure', 'progressive.x'), code('E_CONFIG_INVALID'));
});

test('unsetConfigValue removes known optional keys and is idempotent when they are absent', () => {
  const withKeys = setConfigValue(
    setConfigValue(defaultConfig('lite'), 'hooks.disclosure', 'progressive'),
    'retrieval.exclude',
    ['drafts/**']
  );
  const removed = unsetConfigValue(withKeys, 'hooks.disclosure');
  assert.equal(Object.hasOwn(removed.hooks, 'disclosure'), false);
  assert.deepEqual(removed.retrieval.exclude, ['drafts/**']);
  assert.equal(unsetConfigValue(removed, 'hooks.disclosure').hooks.disclosure, undefined);
  assert.deepEqual(unsetConfigValue(removed, 'retrieval.exclude'), defaultConfig('lite'));
});

test('unsetConfigValue refuses required, unknown and locked keys', () => {
  const cfg = defaultConfig('lite');
  const snapshot = JSON.stringify(cfg);
  for (const key of [
    'schemaVersion',
    'retrieval.budgetChars',
    'hooks.mode',
    'nope',
    'hooks.nope',
    'retrieval.shadow.abstainThreshold',
  ]) {
    assert.throws(() => unsetConfigValue(cfg, key), code('E_CONFIG_KEY'), key);
  }
  for (const key of ['telemetry', 'safety.secretFilter'])
    assert.throws(() => unsetConfigValue(cfg, key), code('E_LOCKED_KEY'));
  assert.equal(JSON.stringify(cfg), snapshot);
});

test('unsetConfigValue treats an absent optional object as a no-op', () => {
  const cfg = defaultConfig('lite');
  assert.deepEqual(unsetConfigValue(cfg, 'retrieval.shadow'), cfg);
  const withShadow = setConfigValue(cfg, 'retrieval.shadow.abstainThreshold', 0.5);
  assert.throws(() => unsetConfigValue(withShadow, 'retrieval.shadow.abstainThreshold'), code('E_CONFIG_KEY'));
});

test('unsetConfigValue removes free-form sync.options keys and is idempotent when absent', () => {
  const cfg = defaultConfig('lite');
  const withRemote = setConfigValue(cfg, 'sync.options.remote', 'https://example.com/repo');
  const removed = unsetConfigValue(withRemote, 'sync.options.remote');
  assert.equal(Object.hasOwn(removed.sync.options, 'remote'), false);
  assert.deepEqual(removed, cfg);
  assert.deepEqual(unsetConfigValue(cfg, 'sync.options.remote'), cfg);
});

test('unsetConfigValue works on a custom profile configuration', () => {
  const cfg = defaultConfig('custom');
  const withDisclosure = setConfigValue(cfg, 'hooks.disclosure', 'progressive');
  const removed = unsetConfigValue(withDisclosure, 'hooks.disclosure');
  assert.equal(Object.hasOwn(removed.hooks, 'disclosure'), false);
  assert.deepEqual(removed, cfg);
});

test('setConfigValue and unsetConfigValue reject prototype-related key segments', () => {
  const cfg = defaultConfig('lite');
  const snapshot = JSON.stringify(cfg);
  for (const key of [
    'sync.options.__proto__',
    'sync.options.constructor',
    'sync.options.prototype',
    '__proto__',
    'constructor.prototype',
  ]) {
    assert.throws(() => setConfigValue(cfg, key, { polluted: true }), code('E_CONFIG_KEY'), key);
    assert.throws(() => unsetConfigValue(cfg, key), code('E_CONFIG_KEY'), key);
  }
  assert.equal(Object.hasOwn(Object.prototype, 'polluted'), false);
  assert.equal(JSON.stringify(cfg), snapshot);
});

test('CLI config set/unset handle optional keys, --plan and help usage', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'ba-config-optional-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_DATA_HOME: join(home, 'data'),
    XDG_STATE_HOME: join(home, 'state'),
    BRAINATLAS_PLATFORM: 'linux',
    BRAINATLAS_OFFLINE: '1',
  };
  const run = (...args) =>
    spawnSync(process.execPath, [resolve('packages/cli/bin/brainatlas.mjs'), ...args], {
      env,
      encoding: 'utf8',
      shell: false,
    });
  assert.equal(
    run('init', '--yes', '--vault', join(home, 'vault'), '--profile', 'lite', '--agents', 'claude-code').status,
    0
  );
  const file = join(home, 'config/brainatlas/config.json');
  const standardFile = join(home, 'vault/.brainatlas/standard.json');
  const before = await readFile(file, 'utf8');
  assert.equal(run('config', 'unset', 'retrieval.shadow', '--json').status, 0);
  assert.equal(await readFile(file, 'utf8'), before);
  assert.equal(run('config', 'unset', 'retrieval.shadow.abstainThreshold').status, 1);
  assert.equal(await readFile(file, 'utf8'), before);
  assert.equal(run('config', 'set', 'hooks.disclosure', 'progressive', '--plan').status, 0);
  assert.equal(await readFile(file, 'utf8'), before);
  let result = run('config', 'set', 'hooks.disclosure', 'progressive', '--json');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { action: 'config set', key: 'hooks.disclosure' });
  assert.equal(JSON.parse(run('config', 'get', 'hooks.disclosure', '--json').stdout), 'progressive');
  result = run('config', 'set', 'retrieval.exclude', '["drafts/**"]', '--json');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(await readFile(standardFile, 'utf8')).retrieval.exclude, ['drafts/**']);
  const withKeys = await readFile(file, 'utf8');
  for (const invalid of [
    ['hooks.disclosure', 'maybe'],
    ['retrieval.exclude', '"x"'],
    ['retrieval.exclude', '["/abs"]'],
  ]) {
    assert.equal(run('config', 'set', ...invalid).status, 1, invalid.join(' '));
    assert.equal(await readFile(file, 'utf8'), withKeys);
  }
  assert.equal(run('config', 'set', 'hooks.nope', 'x').status, 1);
  assert.equal(await readFile(file, 'utf8'), withKeys);
  const planned = await readFile(file, 'utf8');
  assert.equal(run('config', 'unset', 'hooks.disclosure', '--plan').status, 0);
  assert.equal(await readFile(file, 'utf8'), planned);
  result = run('config', 'unset', 'hooks.disclosure', '--json');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { action: 'config unset', key: 'hooks.disclosure' });
  const configText = await readFile(file, 'utf8');
  assert.equal(Object.hasOwn(JSON.parse(configText).hooks, 'disclosure'), false);
  assert.equal(run('config', 'unset', 'retrieval.exclude').status, 0);
  assert.equal(Object.hasOwn(JSON.parse(await readFile(standardFile, 'utf8')).retrieval, 'exclude'), false);
  const stable = await readFile(file, 'utf8');
  assert.equal(run('config', 'unset', 'retrieval.exclude').status, 0);
  assert.equal(await readFile(file, 'utf8'), stable);
  assert.equal(run('config', 'set', 'sync.options.remote', 'https://example.com/repo').status, 0);
  result = run('config', 'unset', 'sync.options.remote', '--json');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { action: 'config unset', key: 'sync.options.remote' });
  assert.equal(Object.hasOwn(JSON.parse(await readFile(file, 'utf8')).sync.options, 'remote'), false);
  assert.equal(run('config', 'unset', 'hooks.mode').status, 1);
  assert.equal(run('config', 'unset', 'telemetry').status, 1);
  const help = run('help', 'config');
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /config get \[KEY\] \| set KEY VALUE \[--plan\] \| unset KEY \[--plan\]/);
});
