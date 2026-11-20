// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePaths } from '@brainatlas/core';
import { signRelease } from '../../release/sign.mjs';
import { cleanEnv } from './clean-env.mjs';

const root = resolve(join(fileURLToPath(new URL('.', import.meta.url)), '../..'));

function run(file, args, env, input = '') {
  return spawnSync(file, args, { cwd: root, env, encoding: 'utf8', input, shell: false, maxBuffer: 4 * 1024 * 1024 });
}

function assertSuccess(result, label) {
  assert.equal(result.error, undefined, `${label}: ${result.error?.message || ''}`);
  assert.equal(result.status, 0, `${label}: ${result.stderr}${result.stdout}`);
}

async function findFile(dir, name) {
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = await findFile(path, name);
      if (found) return found;
    } else if (entry.name === name) return path;
  }
  return null;
}

test('installed full release prompt hook finds the semantic module', { timeout: 180_000 }, async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'ba-installed-semantic-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const key = join(temp, 'release-key');
  const signers = join(temp, 'allowed-signers');
  const output = join(temp, 'release-output');
  const home = join(temp, 'home');
  const vault = join(temp, 'vault');
  await mkdir(output, { recursive: true });
  await mkdir(home, { recursive: true });
  const env = {
    ...cleanEnv({
      PATH: process.env.PATH || '/usr/bin:/bin',
      TMPDIR: temp,
      BRAINATLAS_PLATFORM: 'linux',
      BRAINATLAS_OFFLINE: '1',
      BRAINATLAS_ALLOWED_SIGNERS: signers,
      LC_ALL: 'C',
    }),
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
  };

  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key], { cwd: root, env, shell: false });
  await writeFile(signers, `brainatlas-release ${(await readFile(`${key}.pub`, 'utf8')).trim()}\n`);
  const version = '0.1.0-ba59-full.1';
  assertSuccess(
    run(
      process.execPath,
      [join(root, 'release/build-release.mjs'), '--version', version, '--profile', 'full', '--out', output],
      env
    ),
    'build full release'
  );
  signRelease(key, join(output, 'SHA256SUMS'));
  assertSuccess(
    run(
      'sh',
      [
        join(root, 'install.sh'),
        '--from',
        join(output, `brainatlas-${version}-full.tgz`),
        '--profile',
        'full',
        '--prefix-home',
        home,
        '--allowed-signers',
        signers,
        '--yes',
      ],
      env
    ),
    'install full release'
  );
  const cli = join(home, '.local', 'share', 'brainatlas', 'current', 'packages', 'cli', 'bin', 'brainatlas.mjs');
  assertSuccess(
    run(process.execPath, [cli, 'init', '--profile', 'full', '--yes', '--vault', vault, '--json'], env),
    'init full profile'
  );
  await writeFile(join(vault, 'wiki', 'entities', 'semantic-page.md'), '# Semantic page\nRelease layout notes.\n');
  assertSuccess(
    run(process.execPath, [cli, 'config', 'set', 'semantic.enabled', 'true', '--json'], env),
    'enable semantic'
  );

  const prompt = JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'release layout notes', cwd: vault });
  assertSuccess(run(process.execPath, [cli, 'hook', 'claude', 'prompt'], env, prompt), 'prompt hook');

  const stateDir = resolvePaths({ platform: 'linux', env }).stateDir;
  const metricsFile = await findFile(stateDir, 'hooks.jsonl');
  assert.ok(metricsFile, 'hook metrics file exists');
  const records = (await readFile(metricsFile, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((record) => record.event === 'prompt' || record.hook === 'prompt' || 'semantic' in record);
  const last = records.at(-1);
  assert.ok(last && typeof last.semantic === 'string', `prompt record has a semantic field: ${JSON.stringify(last)}`);
  assert.notEqual(last.semantic, 'fallback:module-missing');
  assert.notEqual(last.semantic, 'fallback:module-load-error');
});
