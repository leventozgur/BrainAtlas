// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultConfig, resolvePaths, saveConfig, vaultStateDir } from '@brainatlas/core';
import { cleanEnv } from './clean-env.mjs';

const root = resolve(join(fileURLToPath(new URL('.', import.meta.url)), '../..'));
const cli = join(root, 'packages', 'cli', 'bin', 'brainatlas.mjs');

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function runStatus(env, command = 'status') {
  const result = spawnSync(process.execPath, [cli, command, '--json'], {
    cwd: root,
    env,
    encoding: 'utf8',
    shell: false,
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(result.error, undefined, result.error?.message || '');
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

async function fixture(t) {
  const temp = await mkdtemp(join(tmpdir(), 'ba50-status-freshness-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const home = join(temp, 'home');
  const vault = join(temp, 'vault');
  const env = cleanEnv({
    PATH: process.env.PATH || '/usr/bin:/bin',
    TMPDIR: temp,
    HOME: home,
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_DATA_HOME: join(home, 'data'),
    XDG_STATE_HOME: join(home, 'state'),
    BRAINATLAS_PLATFORM: 'linux',
    BRAINATLAS_OFFLINE: '1',
  });
  const paths = resolvePaths({ platform: 'linux', env });
  const releaseDir = join(paths.releasesDir, 'ba50-fixture');
  await mkdir(join(releaseDir, 'modules'), { recursive: true });
  await cp(join(root, 'modules', 'semantic'), join(releaseDir, 'modules', 'semantic'), { recursive: true });
  await symlink(join(root, 'packages'), join(releaseDir, 'packages'), 'dir');
  await symlink('releases/ba50-fixture', paths.currentDir, 'dir');
  const config = defaultConfig('custom');
  config.modules = ['semantic'];
  config.vault.path = vault;
  config.semantic.enabled = true;
  await saveConfig(config, { paths });
  return { home, vault, wiki: join(vault, 'wiki'), paths, env };
}

async function writeIndex(f, fileHashes) {
  const dir = join(vaultStateDir(f.paths, f.vault), 'semantic');
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'index.json'),
    `${JSON.stringify({
      version: 1,
      providerId: 'ba50-fixture',
      providerFingerprint: null,
      preprocessVersion: 1,
      dims: 2,
      createdAt: new Date().toISOString(),
      fileHashes,
      entries: [],
    })}\n`
  );
}

function semanticHealth(report) {
  const entry = report.moduleHealth.find((item) => item.name === 'semantic');
  assert.ok(entry, JSON.stringify(report));
  return entry;
}

function assertFreshness(report, expected) {
  const { freshness } = semanticHealth(report);
  assert.deepEqual(
    { indexed: freshness.indexed, stale: freshness.stale, missing: freshness.missing },
    expected,
    JSON.stringify(report)
  );
}

test('status measures semantic freshness against the vault wiki directory', async (t) => {
  const f = await fixture(t);
  const alpha = '# Alpha\nFirst page bytes.\n';
  const beta = '# Beta\nSecond page bytes.\n';
  await mkdir(join(f.wiki, 'concepts'), { recursive: true });
  await writeFile(join(f.wiki, 'concepts', 'a.md'), alpha);
  await writeFile(join(f.wiki, 'b.md'), beta);
  await writeIndex(f, { 'concepts/a.md': sha256(alpha), 'b.md': sha256(beta) });

  assertFreshness(runStatus(f.env), { indexed: 2, stale: 0, missing: 0 });

  const changed = '# Alpha\nChanged page bytes.\n';
  await writeFile(join(f.wiki, 'concepts', 'a.md'), changed);
  assertFreshness(runStatus(f.env), { indexed: 2, stale: 1, missing: 0 });

  await writeFile(join(f.wiki, 'C.md'), '# Gamma\nNew page.\n');
  await mkdir(join(f.vault, 'planning'), { recursive: true });
  await mkdir(join(f.vault, 'raw'), { recursive: true });
  await writeFile(join(f.vault, 'root.md'), '# Root\n');
  await writeFile(join(f.vault, 'planning', 'plan.md'), '# Plan\n');
  await writeFile(join(f.vault, 'raw', 'capture.md'), '# Capture\n');
  assertFreshness(runStatus(f.env), { indexed: 2, stale: 1, missing: 1 });
});

test('status keeps the freshness warning and never fails when the wiki directory is missing', async (t) => {
  const f = await fixture(t);
  await writeIndex(f, { 'a.md': sha256('# A\n') });
  await rm(f.wiki, { recursive: true, force: true });

  const report = runStatus(f.env);
  assert.equal(semanticHealth(report).freshness, null);
  assert.ok(report.warnings.includes('Semantic index freshness is unavailable.'), JSON.stringify(report));

  const diagnosed = runStatus(f.env, 'doctor');
  assert.equal(semanticHealth(diagnosed).freshness, null);
  assert.ok(diagnosed.warnings.includes('Semantic index freshness is unavailable.'), JSON.stringify(diagnosed));
});
