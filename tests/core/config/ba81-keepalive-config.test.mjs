// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import {
  CONFIG_SCHEMA,
  SEMANTIC_DEFAULTS,
  defaultConfig,
  loadConfig,
  setConfigValue,
  validateConfig,
} from '../../../packages/core/src/config/index.mjs';

const withSemantic = (keepAlive) => {
  const cfg = defaultConfig('custom');
  cfg.semantic.keepAlive = keepAlive;
  return cfg;
};

test('the default is "30m" in SEMANTIC_DEFAULTS and stays out of written config', async (t) => {
  assert.equal(SEMANTIC_DEFAULTS.keepAlive, '30m');
  assert.equal('keepAlive' in defaultConfig('full').semantic, false, 'older releases must read the written config');
  assert.equal(CONFIG_SCHEMA.properties.semantic.properties.keepAlive.type, 'string');
  assert.equal(CONFIG_SCHEMA.properties.semantic.properties.keepAlive.pattern, '^(?:0|[1-9][0-9]{0,4}[smh])$');
  assert.equal(validateConfig(defaultConfig('custom')).ok, true);
  const root = await mkdtemp(join(tmpdir(), 'ba81-keepalive-load-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configFile = join(root, 'config.json');
  const cfg = defaultConfig('custom');
  delete cfg.semantic.keepAlive;
  await mkdir(dirname(configFile), { recursive: true });
  await writeFile(configFile, JSON.stringify(cfg));
  assert.equal('keepAlive' in JSON.parse(await readFile(configFile, 'utf8')).semantic, false);
  assert.equal((await loadConfig({ paths: { configFile } })).semantic.keepAlive, undefined);
});

test('valid durations are accepted and invalid values fail with the schema error codes', () => {
  for (const good of ['0', '1s', '30m', '2h', '5m', '99999h']) {
    assert.equal(validateConfig(withSemantic(good)).ok, true, good);
  }
  for (const bad of ['', 'm', '0m', '01m', '30', '1d', '30m ', ' 30m', '100000h', 30, null, true, []]) {
    const result = validateConfig(withSemantic(bad));
    assert.equal(result.ok, false, String(bad));
    assert.ok(
      result.errors.some(
        (error) => error.path === 'semantic.keepAlive' && ['E_PATTERN', 'E_TYPE'].includes(error.code)
      ),
      `${String(bad)}: ${JSON.stringify(result.errors)}`
    );
  }
});

test('setConfigValue accepts a duration and rejects an invalid one', () => {
  const cfg = defaultConfig('custom');
  assert.equal('keepAlive' in cfg.semantic, false);
  assert.equal(setConfigValue(cfg, 'semantic.keepAlive', '1h').semantic.keepAlive, '1h');
  assert.equal(cfg.semantic.keepAlive, undefined, 'the input config is not mutated');
  assert.equal(setConfigValue(cfg, 'semantic.dims', 42).semantic.keepAlive, undefined, 'other keys never write it');
  assert.throws(() => setConfigValue(cfg, 'semantic.keepAlive', '1d'), { code: 'E_CONFIG_INVALID' });
  assert.throws(() => setConfigValue(cfg, 'semantic.keepAlive', 30), { code: 'E_CONFIG_INVALID' });
});

test('brainatlas config set semantic.keepAlive 1h persists the value', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'ba81-keepalive-cli-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = {
    PATH: process.env.PATH || '/usr/bin:/bin',
    HOME: home,
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_DATA_HOME: join(home, 'data'),
    XDG_STATE_HOME: join(home, 'state'),
    BRAINATLAS_PLATFORM: 'linux',
    BRAINATLAS_OFFLINE: '1',
  };
  const run = (...args) =>
    new Promise((done, fail) => {
      const child = spawn(process.execPath, [resolve('packages/cli/bin/brainatlas.mjs'), ...args], { env });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.on('error', fail);
      child.on('close', (status) => done({ status, stdout, stderr }));
    });
  let result = await run('config', 'set', 'semantic.keepAlive', '1h', '--json');
  assert.equal(result.status, 0, result.stderr);
  result = await run('config', 'get', 'semantic.keepAlive', '--json');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout), '1h');
});
