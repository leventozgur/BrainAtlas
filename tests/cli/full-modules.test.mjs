// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolvePaths } from '@brainatlas/core';
import { signRelease } from '../../release/sign.mjs';
import { cleanEnv } from './clean-env.mjs';

const root = resolve(join(fileURLToPath(new URL('.', import.meta.url)), '../..'));

function run(file, args, env, { input = '' } = {}) {
  return spawnSync(file, args, { cwd: root, env, encoding: 'utf8', input, shell: false, maxBuffer: 4 * 1024 * 1024 });
}

function assertSuccess(result, label) {
  assert.equal(result.error, undefined, `${label}: ${result.error?.message || ''}`);
  assert.equal(result.status, 0, `${label}: ${result.stderr}${result.stdout}`);
}

test('installed full release wires transports, strict OKF, review commands and session-end receipts', { timeout: 180_000 }, async t => {
  const temp = await mkdtemp(join(tmpdir(), 'ba-full-modules-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const key = join(temp, 'release-key');
  const signers = join(temp, 'allowed-signers');
  const output = join(temp, 'release-output');
  const bareRemote = join(temp, 'sync-remote.git');
  const gitConfig = join(temp, 'git-config');
  const hostAHome = join(temp, 'host-a-home');
  const hostBHome = join(temp, 'host-b-home');
  const hostAVault = join(temp, 'host-a-vault');
  const hostBVault = join(temp, 'host-b-vault');
  await mkdir(output, { recursive: true });
  await writeFile(gitConfig, '');

  const baseEnv = cleanEnv({
    PATH: process.env.PATH || '/usr/bin:/bin',
    TMPDIR: temp,
    BRAINATLAS_PLATFORM: 'linux',
    BRAINATLAS_OFFLINE: '1',
    BRAINATLAS_ALLOWED_SIGNERS: signers,
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    LC_ALL: 'C'
  });
  const hostEnv = (home, hostId) => ({
    ...baseEnv,
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    BRAINATLAS_HOST_ID: hostId
  });
  const envA = hostEnv(hostAHome, 'host-a');
  const envB = hostEnv(hostBHome, 'host-b');
  await mkdir(hostAHome, { recursive: true });
  await mkdir(hostBHome, { recursive: true });

  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key], { cwd: root, env: envA, shell: false });
  await writeFile(signers, `brainatlas-release ${(await readFile(`${key}.pub`, 'utf8')).trim()}\n`);
  const version = '0.1.0-integ3-full.1';
  const built = run(process.execPath, [join(root, 'release/build-release.mjs'), '--version', version, '--profile', 'full', '--out', output], envA);
  assertSuccess(built, 'build full release');
  const archive = join(output, `brainatlas-${version}-full.tgz`);
  signRelease(key, join(output, 'SHA256SUMS'));

  for (const [home, env] of [[hostAHome, envA], [hostBHome, envB]]) {
    const installed = run('sh', [join(root, 'install.sh'), '--from', archive, '--profile', 'full', '--prefix-home', home, '--allowed-signers', signers, '--yes'], env);
    assertSuccess(installed, `install full release for ${home}`);
    const cli = join(home, '.local', 'share', 'brainatlas', 'current', 'packages', 'cli', 'bin', 'brainatlas.mjs');
    const initialized = run(process.execPath, [cli, 'init', '--profile', 'full', '--yes', '--vault', home === hostAHome ? hostAVault : hostBVault, '--json'], env);
    assertSuccess(initialized, `init full profile for ${home}`);
  }

  const git = run('git', ['init', '--bare', '--quiet', bareRemote], envA);
  assertSuccess(git, 'create local bare remote');
  const remote = pathToFileURL(bareRemote).href;
  const cliA = join(hostAHome, '.local', 'share', 'brainatlas', 'current', 'packages', 'cli', 'bin', 'brainatlas.mjs');
  const cliB = join(hostBHome, '.local', 'share', 'brainatlas', 'current', 'packages', 'cli', 'bin', 'brainatlas.mjs');
  for (const [cli, env] of [[cliA, envA], [cliB, envB]]) {
    assertSuccess(run(process.execPath, [cli, 'config', 'set', 'sync.transport', 'git', '--json'], env), 'select Git transport');
    assertSuccess(run(process.execPath, [cli, 'config', 'set', 'sync.options.remote', remote, '--json'], env), 'configure local remote');
  }

  await mkdir(join(hostAVault, 'wiki', 'entities'), { recursive: true });
  await mkdir(join(hostBVault, 'wiki', 'entities'), { recursive: true });
  await writeFile(join(hostAVault, 'wiki', 'entities', 'integration.md'), '# Integration\nA shared page.\n');
  assertSuccess(run(process.execPath, [cliA, 'sync', 'run', '--json'], envA), 'sync host A');
  assertSuccess(run(process.execPath, [cliB, 'sync', 'run', '--json'], envB), 'sync host B');

  const stateB = resolvePaths({ platform: 'linux', env: envB }).stateDir;
  const checked = run(process.execPath, [cliA, 'sync', 'check', '--peer', stateB, '--json'], envA);
  assertSuccess(checked, 'compare host states');
  assert.equal(JSON.parse(checked.stdout).status, 'PASS');

  await writeFile(join(hostAVault, 'wiki', 'entities', 'strict-failure.md'), '---\ntype: summary\ngenerated: invalid\nstatus: confirmed\nverified: []\nsources: []\n---\n\nNot fully sourced.\n');
  const strict = run(process.execPath, [cliA, 'okf', 'check', '--strict', '--json'], envA);
  assert.equal(strict.status, 1, strict.stderr);
  assert.ok(JSON.parse(strict.stdout).findings.length > 0);

  const review = run(process.execPath, [cliA, 'review', 'list', '--json'], envA);
  assertSuccess(review, 'list queued reviews before hook');
  assert.deepEqual(JSON.parse(review.stdout), []);

  const hook = run(process.execPath, [cliA, 'hook', 'claude', 'session-end'], envA);
  assertSuccess(hook, 'queue session-end receipt');
  const stateA = resolvePaths({ platform: 'linux', env: envA }).stateDir;
  const queue = join(stateA, 'receipts', 'queue');
  const receipts = (await readdir(queue)).filter(name => name.endsWith('.json'));
  assert.equal(receipts.length, 1);
  assert.equal(JSON.parse(await readFile(join(queue, receipts[0]), 'utf8')).client, 'claude');
});
