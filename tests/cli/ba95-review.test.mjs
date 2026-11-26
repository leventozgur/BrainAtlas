// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolvePaths, STANDARD_VERSION } from '../../packages/core/src/index.mjs';
import { cleanEnv } from './clean-env.mjs';

const BIN = resolve('packages/cli/bin/brainatlas.mjs');

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'ba95-review-cli-'));
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
  const ok = (...args) => {
    const result = run(...args, '--json');
    assert.equal(result.status, 0, result.stderr + result.stdout);
    return JSON.parse(result.stdout);
  };
  const standardFile = join(vault, '.brainatlas', 'standard.json');
  const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));
  const release = async () => {
    await mkdir(join(paths.releasesDir, 'ba95'), { recursive: true });
    await symlink('releases/ba95', paths.currentDir);
  };
  return { base, home, vault, env, paths, run, ok, standardFile, readJson, release };
}

test('config set --device persists a value equal to the standard value and keeps other device values', async (t) => {
  const f = await fixture(t);
  f.ok('init', '--yes', '--vault', f.vault);
  const device = await f.readJson(f.paths.configFile);
  const standard = await f.readJson(f.standardFile);
  standard.okf.level = 'strict';
  standard.retrieval.budgetChars = device.retrieval.budgetChars + 1;
  await writeFile(f.standardFile, `${JSON.stringify(standard, null, 2)}\n`);
  assert.equal(device.okf.level, 'warn');

  const set = f.run('config', 'set', 'okf.level', 'strict', '--device', '--json');
  assert.equal(set.status, 0, set.stderr);
  const after = await f.readJson(f.paths.configFile);
  assert.equal(after.okf.level, 'strict');
  assert.equal(after.retrieval.budgetChars, device.retrieval.budgetChars);
  assert.equal((await f.readJson(f.standardFile)).okf.level, 'strict');
});

test('config set and unset refuse a standard from a newer BrainAtlas or an invalid one and never rewrite it', async (t) => {
  const f = await fixture(t);
  f.ok('init', '--yes', '--vault', f.vault);
  const standard = await f.readJson(f.standardFile);
  const newer = `${JSON.stringify({ ...standard, standardVersion: STANDARD_VERSION + 1 }, null, 2)}\n`;
  await writeFile(f.standardFile, newer);
  for (const args of [
    ['config', 'set', 'okf.level', 'strict'],
    ['config', 'unset', 'retrieval.exclude'],
  ]) {
    const result = f.run(...args, '--json');
    assert.notEqual(result.status, 0);
    const text = result.stderr + result.stdout;
    assert.match(text, /E_STANDARD_VERSION/);
    assert.match(text, /The vault standard was written by a newer BrainAtlas; update this device\./);
    assert.equal(await readFile(f.standardFile, 'utf8'), newer);
  }
  await writeFile(f.standardFile, '{');
  const invalid = f.run('config', 'set', 'okf.level', 'strict', '--json');
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr + invalid.stdout, /E_STANDARD_INVALID/);
  assert.equal(await readFile(f.standardFile, 'utf8'), '{');
});

test('okf.level off is refused for the standard and the device config', async (t) => {
  const f = await fixture(t);
  f.ok('init', '--yes', '--vault', f.vault);
  const standardResult = f.run('config', 'set', 'okf.level', 'off', '--json');
  assert.notEqual(standardResult.status, 0);
  assert.match(standardResult.stderr + standardResult.stdout, /E_STANDARD_INVALID/);
  assert.equal((await f.readJson(f.standardFile)).okf.level, 'warn');
  const deviceResult = f.run('config', 'set', 'okf.level', 'off', '--device', '--json');
  assert.notEqual(deviceResult.status, 0);
  assert.equal((await f.readJson(f.paths.configFile)).okf.level, 'warn');
});

test('doctor reports an adapter plan failure as a warning that does not change ok', async (t) => {
  const f = await fixture(t);
  f.ok('init', '--yes', '--vault', f.vault, '--agents', 'claude-code');
  await f.release();
  const baseline = f.ok('doctor');
  assert.equal(baseline.ok, true);
  assert.equal(
    baseline.warnings.some((item) => /adapter plan failed/.test(item)),
    false
  );
  const claudeJson = join(f.home, '.claude.json');
  await rm(claudeJson, { recursive: true, force: true });
  await mkdir(claudeJson, { recursive: true });
  const broken = JSON.parse(f.run('doctor', '--json').stdout);
  assert.ok(broken.warnings.includes('claude-code adapter plan failed (EISDIR).'), JSON.stringify(broken.warnings));
  assert.equal(broken.conformance.adaptersCurrent['claude-code'], false);
  assert.equal(
    broken.warnings.some((item) => /adapter files are out of date/.test(item)),
    false
  );
  assert.equal(broken.ok, Object.values(broken.checks).every(Boolean));
});

test('doctor and maintain accept policy command references provided by active modules', async (t) => {
  const f = await fixture(t);
  f.ok('init', '--yes', '--vault', f.vault);
  await f.release();
  const moduleDir = join(f.paths.releasesDir, 'ba95', 'modules', 'okf-fixture');
  await mkdir(join(moduleDir, 'src'), { recursive: true });
  await writeFile(
    join(moduleDir, 'module.json'),
    `${JSON.stringify({
      name: 'okf-fixture',
      version: '1.0.0',
      description: 'okf command fixture',
      requires: [],
      provides: [],
      profiles: ['full'],
      entry: 'src/index.mjs',
    })}\n`
  );
  await writeFile(
    join(moduleDir, 'src/index.mjs'),
    'export async function activate() {}\nexport const commands = { okf() { return {}; } };\n'
  );
  const agents = join(f.vault, 'AGENTS.md');
  await writeFile(agents, `${await readFile(agents, 'utf8')}\nRun brainatlas okf check before commits.\n`);
  const missing = 'AGENTS.md: command brainatlas okf does not exist.';

  const before = f.ok('doctor');
  assert.ok(before.warnings.includes(missing));
  assert.ok(f.ok('maintain').policy.warnings.includes(missing));

  const cfg = await f.readJson(f.paths.configFile);
  cfg.modules = ['okf-fixture'];
  await writeFile(f.paths.configFile, `${JSON.stringify(cfg, null, 2)}\n`);
  const after = f.ok('doctor');
  assert.equal(after.warnings.includes(missing), false);
  assert.equal(f.ok('maintain').policy.warnings.includes(missing), false);
});
