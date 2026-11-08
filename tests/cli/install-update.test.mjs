// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { buildRelease } from '../../release/build-release.mjs';
import { signRelease } from '../../release/sign.mjs';

async function signedLite(dir, version, key) {
  const [archive, sums] = await buildRelease({ version, profile: 'lite', out: dir });
  signRelease(key, sums);
  return archive;
}

test('offline install, update, doctor rollback, rollback and interrupted journal recovery use a fake HOME', async t => {
  const work = await mkdtemp(join(tmpdir(), 'ba-install-flow-')); t.after(() => rm(work, { recursive: true, force: true }));
  const home = join(work, "home with ' quote"); const out1 = join(work, 'v1'); const out2 = join(work, 'v2'); const out3 = join(work, 'v3');
  await mkdir(home); const key = join(work, 'release-key');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key]);
  const signers = join(work, 'allowed_signers');
  await writeFile(signers, `brainatlas-release ${(await readFile(`${key}.pub`, 'utf8')).trim()}\n`);
  const v1 = await signedLite(out1, '0.1.0-test.1', key);
  const v2 = await signedLite(out2, '0.1.0-test.2', key);
  const v3 = await signedLite(out3, '0.1.0-test.3', key);
  const env = {
    ...process.env, HOME: home,
    XDG_DATA_HOME: join(home, 'data'), XDG_CONFIG_HOME: join(home, 'config'), XDG_STATE_HOME: join(home, 'state'),
    BRAINATLAS_PLATFORM: 'linux', BRAINATLAS_OFFLINE: '1', BRAINATLAS_ALLOWED_SIGNERS: signers
  };
  const install = (...args) => spawnSync('sh', [resolve('install.sh'), ...args], { cwd: resolve('.'), env, encoding: 'utf8' });
  const cliPath = resolve('packages/cli/bin/brainatlas.mjs');
  const run = (...args) => spawnSync(process.execPath, [cliPath, ...args], { cwd: resolve('.'), env, encoding: 'utf8' });
  const data = join(home, 'data', 'brainatlas'); const current = join(data, 'current');

  const installed = install('--from', v1, '--allowed-signers', signers, '--prefix-home', home, '--yes');
  assert.equal(installed.status, 0, installed.stderr);
  assert.equal(await readlink(current), 'releases/0.1.0-test.1');
  assert.equal(await readlink(join(home, '.local/bin/brainatlas')), join(data, 'bin/brainatlas'));
  assert.equal(await readlink(join(home, '.local/bin/ba')), join(data, 'bin/brainatlas'));
  const status = run('status', '--json'); assert.equal(status.status, 0); assert.equal(JSON.parse(status.stdout).checks.config, true);
  const metadataOffline = run('update', '--metadata-only', '--json');
  assert.equal(metadataOffline.status, 0, metadataOffline.stderr);
  assert.deepEqual(JSON.parse(metadataOffline.stdout), { status: 'unknown', reason: 'offline' });
  const metadataArchive = run('update', '--metadata-only', '--from', v2, '--json');
  assert.equal(metadataArchive.status, 0, metadataArchive.stderr);
  assert.equal(JSON.parse(metadataArchive.stdout).status, 'available');
  assert.equal(JSON.parse(metadataArchive.stdout).currentVersion, '0.1.0-test.1');
  assert.equal(JSON.parse(metadataArchive.stdout).offeredVersion, '0.1.0-test.2');
  const updated = run('update', '--from', v2, '--json'); assert.equal(updated.status, 0, updated.stderr);
  assert.equal(await readlink(current), 'releases/0.1.0-test.2');
  const failed = spawnSync(process.execPath, [cliPath, 'update', '--from', v3, '--json'], { cwd: resolve('.'), env: { ...env, BRAINATLAS_TEST_DOCTOR_FAIL: '1' }, encoding: 'utf8' });
  assert.equal(failed.status, 1); assert.match(failed.stderr, /E_DOCTOR_FAILED/);
  assert.equal(await readlink(current), 'releases/0.1.0-test.2');
  const rolledBack = run('rollback', '--json'); assert.equal(rolledBack.status, 0, rolledBack.stderr);
  assert.equal(await readlink(current), 'releases/0.1.0-test.1');

  await rm(current); await symlink('releases/0.1.0-test.3', current);
  const journalFile = join(home, 'state', 'brainatlas', 'update-journal.json');
  await mkdir(join(home, 'state', 'brainatlas'), { recursive: true });
  await writeFile(journalFile, `${JSON.stringify({ schemaVersion: 1, kind: 'update', phase: 'switching', version: '0.1.0-test.3', target: 'releases/0.1.0-test.3', previous: 'releases/0.1.0-test.1', staging: null })}\n`);
  const recovered = run('recover', '--json'); assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(JSON.parse(recovered.stdout).action, 'restored-previous-release');
  assert.equal(await readlink(current), 'releases/0.1.0-test.1');
  await assert.rejects(readFile(journalFile), { code: 'ENOENT' });
});

test('install manifest records resolved paths under a symlinked ~/.local and uninstall removes them', async t => {
  const work = await mkdtemp(join(tmpdir(), 'ba-install-symlink-home-')); t.after(() => rm(work, { recursive: true, force: true }));
  const home = join(work, 'home'); const localTarget = join(work, 'local-target'); const out = join(work, 'release');
  await mkdir(home); await mkdir(localTarget); await writeFile(join(localTarget, 'sentinel'), 'keep\n');
  await symlink(localTarget, join(home, '.local'));
  const resolvedLocalTarget = await realpath(localTarget);
  const key = join(work, 'release-key'); execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key]);
  const signers = join(work, 'allowed_signers'); await writeFile(signers, `brainatlas-release ${(await readFile(`${key}.pub`, 'utf8')).trim()}\n`);
  const archive = await signedLite(out, '0.1.0-symlink.1', key);
  const env = { ...process.env, HOME: home, BRAINATLAS_PLATFORM: 'linux', BRAINATLAS_OFFLINE: '1', BRAINATLAS_ALLOWED_SIGNERS: signers };
  const install = spawnSync('sh', [resolve('install.sh'), '--from', archive, '--allowed-signers', signers, '--prefix-home', home, '--yes'], { cwd: resolve('.'), env, encoding: 'utf8' });
  assert.equal(install.status, 0, install.stderr);
  const data = join(resolvedLocalTarget, 'share', 'brainatlas');
  const manifestPath = join(data, 'install-manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.ok(manifest.files.some(item => item.path === join(resolvedLocalTarget, 'bin', 'brainatlas')));
  assert.ok(manifest.files.some(item => item.path.startsWith(`${data}${sep}`)));
  assert.ok(manifest.files.every(item => !item.path.startsWith(join(home, '.local'))));

  const cli = join(data, 'current', 'packages', 'cli', 'bin', 'brainatlas.mjs');
  const uninstalled = spawnSync(process.execPath, [cli, 'uninstall', '--json'], { cwd: resolve('.'), env, encoding: 'utf8' });
  assert.equal(uninstalled.status, 0, uninstalled.stderr);
  await assert.rejects(lstat(data), { code: 'ENOENT' });
  await assert.rejects(lstat(join(localTarget, 'bin')), { code: 'ENOENT' });
  assert.equal(await readFile(join(localTarget, 'sentinel'), 'utf8'), 'keep\n');
});

test('install rejects a wrong checksum and an invalid signature before creating a current release', async t => {
  const work = await mkdtemp(join(tmpdir(), 'ba-install-reject-')); t.after(() => rm(work, { recursive: true, force: true }));
  const out = join(work, 'release'); const key = join(work, 'release-key');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key]);
  const signers = join(work, 'allowed_signers'); await writeFile(signers, `brainatlas-release ${(await readFile(`${key}.pub`, 'utf8')).trim()}\n`);
  const archive = await signedLite(out, '0.1.0-test.1', key);
  const env = { ...process.env, HOME: join(work, 'home'), XDG_DATA_HOME: join(work, 'home/data'), BRAINATLAS_PLATFORM: 'linux' };
  const runInstall = file => spawnSync('sh', [resolve('install.sh'), '--from', file, '--allowed-signers', signers, '--prefix-home', env.HOME, '--yes'], { cwd: resolve('.'), env, encoding: 'utf8' });
  const badHash = join(work, 'bad-hash'); await mkdir(badHash);
  await copyFile(archive, join(badHash, archive.split('/').at(-1)));
  await writeFile(join(badHash, 'SHA256SUMS'), `0000000000000000000000000000000000000000000000000000000000000000  ${archive.split('/').at(-1)}\n`);
  const hashResult = runInstall(join(badHash, archive.split('/').at(-1)));
  assert.equal(hashResult.status, 1); assert.match(hashResult.stderr, /E_SHA_MISMATCH/);
  assert.equal(await readlink(join(env.HOME, 'data', 'brainatlas', 'current')).catch(() => null), null);

  const badSignature = join(work, 'bad-signature'); await mkdir(badSignature);
  await copyFile(archive, join(badSignature, archive.split('/').at(-1)));
  await copyFile(join(out, 'SHA256SUMS'), join(badSignature, 'SHA256SUMS'));
  await writeFile(join(badSignature, 'SHA256SUMS.sig'), 'invalid signature\n');
  const signatureResult = runInstall(join(badSignature, archive.split('/').at(-1)));
  assert.equal(signatureResult.status, 1); assert.match(signatureResult.stderr, /E_SIGNATURE_INVALID/);
});
