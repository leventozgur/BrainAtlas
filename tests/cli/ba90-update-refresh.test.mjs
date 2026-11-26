// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { defaultConfig, resolvePaths } from '../../packages/core/src/index.mjs';
import { buildRelease } from '../../release/build-release.mjs';
import { signRelease } from '../../release/sign.mjs';
import { cleanEnv } from './clean-env.mjs';

async function signedLite(dir, version, key) {
  const [archive, sums] = await buildRelease({ version, profile: 'lite', out: dir });
  signRelease(key, sums);
  return archive;
}

async function fakeReleaseSource(work) {
  const root = resolve('.');
  const source = join(work, 'fake-source');
  await mkdir(join(source, 'release'), { recursive: true });
  for (const name of ['package.json', 'package-lock.json']) await cp(join(root, name), join(source, name));
  for (const name of ['packages/core', 'packages/mcp', 'packages/hooks', 'packages/cli', 'vendor', 'templates'])
    await cp(join(root, name), join(source, name), { recursive: true });
  await cp(join(root, 'release', 'allowed_signers'), join(source, 'release', 'allowed_signers'));
  await symlink(join(root, 'node_modules'), join(source, 'node_modules'), 'dir');
  await writeFile(
    join(source, 'packages', 'cli', 'bin', 'brainatlas.mjs'),
    `const command = process.argv[2];
if (command === 'doctor') {
  console.log(JSON.stringify({ ok: true, checks: {} }));
  process.exit(0);
}
if (command === 'agent') {
  if (process.env.BA90_REFRESH_MODE === 'bad-json') {
    console.log('not json');
    process.exit(0);
  }
  process.exit(1);
}
process.exit(0);
`
  );
  return source;
}

async function installFixtureLite(work, archive, signers, env) {
  const home = join(work, 'home');
  await mkdir(home, { recursive: true });
  const installed = spawnSync(
    'sh',
    [resolve('install.sh'), '--from', archive, '--allowed-signers', signers, '--prefix-home', home, '--yes'],
    { cwd: resolve('.'), env, encoding: 'utf8', shell: false }
  );
  assert.equal(installed.status, 0, installed.stderr);
}

test('update refreshes adapters only after a successful switch, never with --plan', async (t) => {
  const work = await mkdtemp(join(tmpdir(), 'ba90-update-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  const home = join(work, 'home');
  const vault = join(work, 'vault');
  await mkdir(home);
  await mkdir(vault);
  const key = join(work, 'release-key');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key], { env: cleanEnv(), shell: false });
  const signers = join(work, 'allowed_signers');
  await writeFile(signers, `brainatlas-release ${(await readFile(`${key}.pub`, 'utf8')).trim()}\n`);
  const v1 = await signedLite(join(work, 'v1'), '0.1.0-ba90.1', key);
  const v2 = await signedLite(join(work, 'v2'), '0.1.0-ba90.2', key);
  const env = cleanEnv({
    HOME: home,
    XDG_DATA_HOME: join(home, 'data'),
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_STATE_HOME: join(home, 'state'),
    BRAINATLAS_PLATFORM: 'linux',
    BRAINATLAS_OFFLINE: '1',
    BRAINATLAS_ALLOWED_SIGNERS: signers,
    PATH: process.env.PATH || '/usr/bin:/bin',
  });
  const installed = spawnSync(
    'sh',
    [resolve('install.sh'), '--from', v1, '--allowed-signers', signers, '--prefix-home', home, '--yes'],
    { cwd: resolve('.'), env, encoding: 'utf8', shell: false }
  );
  assert.equal(installed.status, 0, installed.stderr);
  const paths = resolvePaths({ platform: 'linux', env });
  const config = defaultConfig('lite');
  config.vault.path = vault;
  config.agents = [];
  await mkdir(join(home, 'config', 'brainatlas'), { recursive: true });
  await writeFile(paths.configFile, `${JSON.stringify(config, null, 2)}\n`);
  const cli = join(paths.currentDir, 'packages', 'cli', 'bin', 'brainatlas.mjs');
  const run = (...args) =>
    spawnSync(process.execPath, [cli, ...args, '--json'], { env, encoding: 'utf8', shell: false });

  const planned = run('update', '--from', v2, '--plan');
  assert.equal(planned.status, 0, planned.stderr);
  assert.equal(JSON.parse(planned.stdout).adapters, undefined);

  const updated = run('update', '--from', v2);
  assert.equal(updated.status, 0, updated.stderr);
  assert.deepEqual(JSON.parse(updated.stdout).adapters, { refreshed: [], skipped: [] });
});

test('update still succeeds when the new release refresh exits non-zero or returns bad JSON', async (t) => {
  const work = await mkdtemp(join(tmpdir(), 'ba90-update-fail-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  const home = join(work, 'home');
  const vault = join(work, 'vault');
  await mkdir(vault);
  const key = join(work, 'release-key');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key], { env: cleanEnv(), shell: false });
  const signers = join(work, 'allowed_signers');
  await writeFile(signers, `brainatlas-release ${(await readFile(`${key}.pub`, 'utf8')).trim()}\n`);
  const v1 = await signedLite(join(work, 'v1'), '0.1.0-ba90.1', key);
  const source = await fakeReleaseSource(work);
  const priorSource = process.env.BRAINATLAS_RELEASE_SOURCE;
  process.env.BRAINATLAS_RELEASE_SOURCE = source;
  let v2;
  let v3;
  try {
    v2 = await signedLite(join(work, 'v2'), '0.1.0-ba90.2', key);
    v3 = await signedLite(join(work, 'v3'), '0.1.0-ba90.3', key);
  } finally {
    if (priorSource === undefined) delete process.env.BRAINATLAS_RELEASE_SOURCE;
    else process.env.BRAINATLAS_RELEASE_SOURCE = priorSource;
  }
  const env = cleanEnv({
    HOME: home,
    XDG_DATA_HOME: join(home, 'data'),
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_STATE_HOME: join(home, 'state'),
    BRAINATLAS_PLATFORM: 'linux',
    BRAINATLAS_OFFLINE: '1',
    BRAINATLAS_ALLOWED_SIGNERS: signers,
    PATH: process.env.PATH || '/usr/bin:/bin',
  });
  await installFixtureLite(work, v1, signers, env);
  const paths = resolvePaths({ platform: 'linux', env });
  const config = defaultConfig('lite');
  config.vault.path = vault;
  config.agents = [];
  await mkdir(join(home, 'config', 'brainatlas'), { recursive: true });
  await writeFile(paths.configFile, `${JSON.stringify(config, null, 2)}\n`);
  const cli = join(paths.releasesDir, '0.1.0-ba90.1', 'packages', 'cli', 'bin', 'brainatlas.mjs');
  const run = (extraEnv, ...args) =>
    spawnSync(process.execPath, [cli, ...args, '--json'], {
      env: { ...env, ...extraEnv },
      encoding: 'utf8',
      shell: false,
    });

  const nonZero = run({}, 'update', '--from', v2);
  assert.equal(nonZero.status, 0, nonZero.stderr);
  assert.deepEqual(JSON.parse(nonZero.stdout).adapters, {
    refreshed: [],
    skipped: [],
    error: 'Agent refresh exited with status 1.',
  });

  const badJson = run({ BA90_REFRESH_MODE: 'bad-json' }, 'update', '--from', v3);
  assert.equal(badJson.status, 0, badJson.stderr);
  assert.deepEqual(JSON.parse(badJson.stdout).adapters, {
    refreshed: [],
    skipped: [],
    error: 'Agent refresh returned invalid JSON.',
  });
});
