// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadConfig, resolvePaths, STANDARD_VERSION } from '../../packages/core/src/index.mjs';
import { cleanEnv } from './clean-env.mjs';

const BIN = resolve('packages/cli/bin/brainatlas.mjs');

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'ba95-cli-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = join(base, 'home');
  const vault = join(base, 'vault');
  await mkdir(home, { recursive: true });
  await mkdir(vault, { recursive: true });
  const env = cleanEnv({
    HOME: home,
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_DATA_HOME: join(home, 'data'),
    XDG_STATE_HOME: join(home, 'state'),
    BRAINATLAS_PLATFORM: 'linux',
    BRAINATLAS_OFFLINE: '1',
    PATH: process.env.PATH || '/usr/bin:/bin',
  });
  const paths = resolvePaths({ platform: 'linux', env });
  await mkdir(join(paths.dataDir, 'bin'), { recursive: true });
  await writeFile(join(paths.dataDir, 'bin', 'brainatlas'), '#!/bin/sh\n');
  const run = (...args) => spawnSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8', shell: false });
  const json = (...args) => {
    const result = run(...args, '--json');
    assert.equal(result.error, undefined, `${args.join(' ')} timed out`);
    return { result, value: JSON.parse(result.stdout) };
  };
  const ok = (...args) => {
    const out = json(...args);
    assert.equal(out.result.status, 0, out.result.stderr + out.result.stdout);
    return out.value;
  };
  const standardFile = join(vault, '.brainatlas', 'standard.json');
  const readStandardFile = async () => JSON.parse(await readFile(standardFile, 'utf8'));
  const release = async () => {
    await mkdir(join(paths.releasesDir, 'ba95'), { recursive: true });
    await symlink('releases/ba95', paths.currentDir);
  };
  return { base, home, vault, env, paths, run, json, ok, standardFile, readStandardFile, release };
}

test('init writes the standard from the values it uses', async (t) => {
  const f = await fixture(t);
  f.ok('init', '--yes', '--vault', f.vault);
  const cfg = JSON.parse(await readFile(f.paths.configFile, 'utf8'));
  const standard = await f.readStandardFile();
  assert.equal(standard.standardVersion, STANDARD_VERSION);
  assert.equal(standard.okf.level, cfg.okf.level);
  assert.equal(standard.retrieval.budgetChars, cfg.retrieval.budgetChars);
  assert.equal(standard.retrieval.abstainThreshold, cfg.retrieval.abstainThreshold);
  assert.deepEqual(standard.safety.extraDenyGlobs, cfg.safety.extraDenyGlobs);
  assert.deepEqual(standard.capabilities.minimum, { read: true, write: true });
});

test('config set and unset write the standard, report the source and keep device settings', async (t) => {
  const f = await fixture(t);
  f.ok('init', '--yes', '--vault', f.vault);
  const deviceBefore = JSON.parse(await readFile(f.paths.configFile, 'utf8'));

  const set = f.json('config', 'set', 'okf.level', 'strict');
  assert.equal(set.result.status, 0, set.result.stderr);
  assert.match(
    set.result.stderr,
    /^okf\.level is a vault standard setting; it applies to every device that uses this vault\.$/m
  );
  assert.equal((await f.readStandardFile()).okf.level, 'strict');
  assert.equal(JSON.parse(await readFile(f.paths.configFile, 'utf8')).okf.level, deviceBefore.okf.level);

  const got = f.ok('config', 'get', 'okf.level');
  assert.equal(got.value, 'strict');
  assert.equal(got.source, 'standard');

  f.ok('config', 'set', 'retrieval.exclude', '["drafts/**"]');
  assert.deepEqual((await f.readStandardFile()).retrieval.exclude, ['drafts/**']);
  f.ok('config', 'unset', 'retrieval.exclude');
  assert.equal((await f.readStandardFile()).retrieval.exclude, undefined);

  const device = f.json('config', 'set', 'okf.level', 'warn', '--device');
  assert.equal(device.result.status, 0, device.result.stderr);
  assert.match(device.result.stderr, /^Device config sets okf\.level; the vault standard value is used\.$/m);
  assert.equal(JSON.parse(await readFile(f.paths.configFile, 'utf8')).okf.level, 'warn');
  assert.equal((await f.readStandardFile()).okf.level, 'strict');
  assert.deepEqual(f.ok('config', 'get', 'okf.level'), { value: 'strict', source: 'standard' });
});

test('agent refresh creates a missing standard once, never overwrites and respects plan and readOnly', async (t) => {
  const f = await fixture(t);
  f.ok('init', '--yes', '--vault', f.vault);
  await rm(f.standardFile, { force: true });

  const planned = f.ok('agent', 'refresh', '--plan');
  assert.deepEqual(planned.standard, { action: 'create' });
  await assert.rejects(readFile(f.standardFile));
  const created = f.ok('agent', 'refresh');
  assert.deepEqual(created.standard, { action: 'create' });

  const standard = await f.readStandardFile();
  standard.okf.level = 'strict';
  await writeFile(f.standardFile, `${JSON.stringify(standard, null, 2)}\n`);
  const kept = f.ok('agent', 'refresh');
  assert.deepEqual(kept.standard, { action: 'none' });
  assert.equal((await f.readStandardFile()).okf.level, 'strict');

  await rm(f.standardFile, { force: true });
  f.ok('config', 'set', 'readOnly', 'true');
  const readOnly = f.ok('agent', 'refresh');
  assert.deepEqual(readOnly.standard, { action: 'none' });
  await assert.rejects(readFile(f.standardFile));
});

test('doctor reports conformance and warnings without changing ok', async (t) => {
  const f = await fixture(t);
  f.ok('init', '--yes', '--vault', f.vault, '--agents', 'claude-code');
  await f.release();

  const fresh = f.ok('doctor');
  assert.equal(fresh.ok, true);
  assert.deepEqual(fresh.conformance, {
    standardVersion: 1,
    policyVersion: 2,
    adaptersCurrent: { 'claude-code': true },
    semantic: 'off',
    minimumMet: { 'claude-code': true },
  });
  assert.ok(!fresh.warnings.includes('The vault has no standard file; run brainatlas agent refresh.'));

  f.ok('config', 'set', 'okf.level', 'strict');
  const diverged = f.ok('doctor');
  assert.equal(diverged.ok, true);
  assert.ok(diverged.warnings.includes('Device config sets okf.level; the vault standard value is used.'));

  const standard = await f.readStandardFile();
  await writeFile(
    f.standardFile,
    `${JSON.stringify({ ...standard, standardVersion: STANDARD_VERSION + 1 }, null, 2)}\n`
  );
  const newer = f.ok('doctor');
  assert.equal(newer.ok, true);
  assert.equal(newer.conformance.standardVersion, STANDARD_VERSION + 1);
  assert.ok(
    newer.warnings.includes(
      `standardVersion ${STANDARD_VERSION + 1} is newer than this BrainAtlas supports; update this device.`
    )
  );

  await writeFile(f.standardFile, '{');
  const invalid = f.ok('doctor');
  assert.equal(invalid.ok, true);
  assert.equal(invalid.conformance.standardVersion, null);
  assert.ok(invalid.warnings.includes('The vault standard is invalid (E_STANDARD_PARSE); device settings are used.'));

  await rm(f.standardFile, { force: true });
  const missing = f.ok('doctor');
  assert.equal(missing.ok, true);
  assert.ok(missing.warnings.includes('The vault has no standard file; run brainatlas agent refresh.'));

  const loaded = await loadConfig({ paths: f.paths, env: f.env });
  assert.equal(loaded.standardApplied, false);
});
