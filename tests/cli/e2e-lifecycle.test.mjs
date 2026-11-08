// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, readFile, readlink, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { buildRelease } from '../../release/build-release.mjs';
import { signRelease } from '../../release/sign.mjs';
import { defaultConfig } from '../../packages/core/src/config/index.mjs';

const root = resolve('.');

async function copyInputs(source, destination) {
  await mkdir(destination, { recursive: true });
  await mkdir(join(destination, 'release'), { recursive: true });
  for (const name of ['package.json', 'package-lock.json']) await cp(join(source, name), join(destination, name));
  for (const name of ['packages/core', 'packages/mcp', 'packages/hooks', 'packages/cli', 'packages/adapters', 'vendor', 'templates', 'release/allowed_signers']) {
    try { await cp(join(source, name), join(destination, name), { recursive: true }); }
    catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
  }
  await symlink(join(source, 'node_modules'), join(destination, 'node_modules'), 'dir');
  const moduleDir = join(destination, 'modules', 'e2e-fixture');
  await mkdir(join(moduleDir, 'src'), { recursive: true });
  await writeFile(join(moduleDir, 'module.json'), `${JSON.stringify({ name: 'e2e-fixture', version: '1.0.0', description: 'Lifecycle test fixture', requires: [], provides: [], profiles: ['full'], entry: 'src/index.mjs' }, null, 2)}\n`);
  await writeFile(join(moduleDir, 'src/index.mjs'), "export async function activate() { throw Object.assign(new Error('stub'), { code: 'E_NOT_IMPLEMENTED' }); }\n");
  const adapterDir = join(destination, 'packages', 'adapters', 'fixture-agent', 'src'); await mkdir(adapterDir, { recursive: true });
  await writeFile(join(adapterDir, 'index.mjs'), `// SPDX-License-Identifier: MIT
import { readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
export const id = 'fixture-agent';
const file = ctx => join(ctx.env.HOME, '.fixture-agent.json');
export async function plan(ctx) {
  const target = file(ctx); let before = null;
  try { before = await readFile(target, 'utf8'); } catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
  const value = before === null ? {} : JSON.parse(before); value.brainatlas = { command: ctx.shimPath };
  const after = JSON.stringify(value, null, 2) + '\\n';
  return { changes: before === after ? [] : [{ file: target, before, after, kind: before === null ? 'create' : 'modify', ownership: 'json-key' }], warnings: [] };
}
export async function apply(changes) { for (const change of changes.changes) await writeFile(change.file, change.after); }
export async function remove(ctx) {
  const target = file(ctx); let value;
  try { value = JSON.parse(await readFile(target, 'utf8')); } catch (cause) { if (cause.code === 'ENOENT') return; throw cause; }
  delete value.brainatlas;
  if (Object.keys(value).length) await writeFile(target, JSON.stringify(value, null, 2) + '\\n'); else await rm(target, { force: true });
}
export async function doctor() { return { ok: true }; }
`);
}

async function snapshot(dir, exclude = []) {
  const result = [];
  async function walk(current) {
    let entries = await readdir(current, { withFileTypes: true }).catch(cause => { if (cause.code === 'ENOENT') return []; throw cause; });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(current, entry.name); const rel = relative(dir, path);
      if (exclude.some(item => rel === item || rel.startsWith(`${item}/`))) continue;
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) result.push([rel, 'link', await readlink(path)]);
      else if (stat.isDirectory()) { result.push([rel, 'dir']); await walk(path); }
      else result.push([rel, 'file', (await readFile(path)).toString('base64'), stat.mode & 0o777]);
    }
  }
  await walk(dir); return result;
}

test('offline install, module lifecycle, doctor rollback and uninstall restore HOME byte-for-byte', async t => {
  const work = await mkdtemp(join(tmpdir(), 'ba-e2e-macos-')); t.after(() => rm(work, { recursive: true, force: true }));
  const source = join(work, 'source'); await copyInputs(root, source);
  const releaseOutput = join(work, 'releases'); await mkdir(releaseOutput);
  const previousSource = process.env.BRAINATLAS_RELEASE_SOURCE; process.env.BRAINATLAS_RELEASE_SOURCE = source;
  t.after(() => { if (previousSource === undefined) delete process.env.BRAINATLAS_RELEASE_SOURCE; else process.env.BRAINATLAS_RELEASE_SOURCE = previousSource; });
  const purityFixture = join(source, 'packages', 'cli', 'src', 'purity-fixture.mjs');
  await writeFile(purityFixture, 'const forbidden = "systemd";\n');
  await assert.rejects(buildRelease({ version: '0.1.0-test-purity', profile: 'lite', out: join(work, 'purity') }), { code: 'E_LITE_PURITY' });
  await rm(purityFixture);
  const versions = ['0.1.0-test.1', '0.1.0-test.2', '0.1.0-test.3']; const artifacts = new Map();
  for (const version of versions) for (const profile of ['lite', 'full']) {
    const [archive] = await buildRelease({ version, profile, out: releaseOutput }); artifacts.set(`${version}-${profile}`, archive);
  }
  const key = join(work, 'release-key'); execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key]);
  const signers = join(work, 'allowed_signers'); await writeFile(signers, `brainatlas-release ${(await readFile(`${key}.pub`, 'utf8')).trim()}\n`);
  signRelease(key, join(releaseOutput, 'SHA256SUMS'));

  const home = join(work, "fake home ' mac"); await mkdir(home);
  const vaultRoot = join(home, 'vaults'); const oldVault = join(vaultRoot, 'prior');
  await mkdir(oldVault, { recursive: true }); await writeFile(join(oldVault, 'keep.md'), 'prior vault bytes\n');
  const dataDir = join(home, 'Library', 'Application Support', 'BrainAtlas'); await mkdir(dataDir, { recursive: true });
  const activeVault = join(dataDir, 'user-vault');
  const priorConfig = defaultConfig('lite'); priorConfig.vault.path = oldVault; priorConfig.node.path = process.execPath;
  await writeFile(join(dataDir, 'config.json'), `${JSON.stringify(priorConfig, null, 2)}\n`);
  const localBin = join(home, '.local', 'bin'); await mkdir(localBin, { recursive: true });
  await writeFile(join(localBin, 'brainatlas'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await writeFile(join(home, 'existing-command'), 'existing target\n'); await symlink(join(home, 'existing-command'), join(localBin, 'ba'));
  await writeFile(join(home, '.fixture-agent.json'), `${JSON.stringify({ userSetting: 'keep' }, null, 2)}\n`);
  const vaultExclusions = ['vaults', relative(home, activeVault)]; const before = await snapshot(home, vaultExclusions);
  const env = { ...process.env, HOME: home, BRAINATLAS_PLATFORM: 'darwin', BRAINATLAS_OFFLINE: '1', BRAINATLAS_ALLOWED_SIGNERS: signers };
  const install = (...args) => spawnSync('sh', [join(root, 'install.sh'), ...args], { cwd: root, env, encoding: 'utf8' });
  const cli = join(dataDir, 'current', 'packages', 'cli', 'bin', 'brainatlas.mjs');
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd: root, env, encoding: 'utf8' });

  const installed = install('--from', artifacts.get('0.1.0-test.1-lite'), '--profile', 'lite', '--vault', activeVault, '--yes', '--prefix-home', home, '--allowed-signers', signers);
  assert.equal(installed.status, 0, installed.stderr);
  assert.equal(await readlink(join(dataDir, 'current')), 'releases/0.1.0-test.1');
  const installManifest = JSON.parse(await readFile(join(dataDir, 'install-manifest.json'), 'utf8'));
  assert.ok(installManifest.files.length >= 4);
  const configPath = await realpath(join(dataDir, 'config.json'));
  const configEntry = installManifest.files.find(item => item.path === configPath);
  assert.match(configEntry.beforeSha256, /^[a-f0-9]{64}$/); assert.match(configEntry.afterSha256, /^[a-f0-9]{64}$/); assert.ok(configEntry.backupPath);
  const initialized = run('init', '--profile', 'lite', '--vault', activeVault, '--agents', 'fixture-agent', '--yes', '--json');
  assert.equal(initialized.status, 0, initialized.stderr);
  assert.equal(JSON.parse(await readFile(join(home, '.fixture-agent.json'), 'utf8')).brainatlas.command, join(dataDir, 'bin', 'brainatlas'));
  await mkdir(activeVault, { recursive: true }); await writeFile(join(activeVault, 'keep.md'), 'vault bytes\n');
  const unavailableEval = run('eval', '--json'); assert.equal(unavailableEval.status, 1); assert.match(unavailableEval.stderr, /E_COMPONENT_MISSING/);
  const updated = run('update', '--from', artifacts.get('0.1.0-test.2-lite'), '--json');
  assert.equal(updated.status, 0, updated.stderr); assert.equal(await readlink(join(dataDir, 'current')), 'releases/0.1.0-test.2');
  const check = run('update', '--check', '--from', artifacts.get('0.1.0-test.2-lite'), '--metadata-only', '--json');
  assert.equal(check.status, 0); assert.equal(JSON.parse(check.stdout).status, 'up-to-date');
  const olderCheck = run('update', '--check', '--from', artifacts.get('0.1.0-test.1-lite'), '--json');
  assert.equal(olderCheck.status, 0); assert.equal(JSON.parse(olderCheck.stdout).status, 'current-newer');
  const unhealthy = spawnSync(process.execPath, [cli, 'update', '--from', artifacts.get('0.1.0-test.3-lite'), '--json'], { cwd: root, env: { ...env, BRAINATLAS_TEST_DOCTOR_FAIL: '1' }, encoding: 'utf8' });
  assert.equal(unhealthy.status, 1); assert.match(unhealthy.stderr, /E_DOCTOR_FAILED/);
  assert.equal(await readlink(join(dataDir, 'current')), 'releases/0.1.0-test.2');
  const rolledBack = run('rollback', '--json'); assert.equal(rolledBack.status, 0, rolledBack.stderr);
  assert.equal(await readlink(join(dataDir, 'current')), 'releases/0.1.0-test.1');
  const added = run('module', 'add', 'e2e-fixture', '--from', artifacts.get('0.1.0-test.2-full'), '--json');
  assert.equal(added.status, 0, added.stderr); assert.match(added.stdout, /installed inactive/);
  const listed = run('module', 'list', '--json'); assert.equal(listed.status, 0); assert.equal(JSON.parse(listed.stdout).modules[0].active, true);
  const removePlan = run('module', 'remove', 'e2e-fixture', '--plan', '--json'); assert.equal(removePlan.status, 0);
  const removed = run('module', 'remove', 'e2e-fixture', '--json'); assert.equal(removed.status, 0, removed.stderr);
  const readded = run('module', 'add', 'e2e-fixture', '--from', artifacts.get('0.1.0-test.2-full'), '--json'); assert.equal(readded.status, 0, readded.stderr);
  const configured = run('config', 'set', 'hooks.deadlineMs', '5000', '--json'); assert.equal(configured.status, 0, configured.stderr);
  const appConfig = JSON.parse(await readFile(join(dataDir, 'config.json'), 'utf8')); appConfig.hooks.deadlineMs = 5001;
  await writeFile(join(dataDir, 'config.json'), `${JSON.stringify(appConfig, null, 2)}\n`);
  const uninstallPlan = run('uninstall', '--plan', '--json'); assert.equal(uninstallPlan.status, 0, uninstallPlan.stderr);
  assert.ok(JSON.parse(uninstallPlan.stdout).files.length >= 4);
  const uninstalled = run('uninstall', '--keep-vault', '--json'); assert.equal(uninstalled.status, 0, uninstalled.stderr);
  assert.deepEqual(await snapshot(home, vaultExclusions), before);
  assert.equal(await readFile(join(activeVault, 'keep.md'), 'utf8'), 'vault bytes\n');
  assert.equal(await readFile(join(oldVault, 'keep.md'), 'utf8'), 'prior vault bytes\n');

  const linuxHome = join(work, 'fake-home-linux'); await mkdir(linuxHome);
  const linuxAgentFile = join(linuxHome, '.fixture-agent.json');
  await writeFile(linuxAgentFile, `${JSON.stringify({ userSetting: 'before' }, null, 2)}\n`);
  const linuxBefore = await snapshot(linuxHome);
  const linuxEnv = { ...env, HOME: linuxHome, BRAINATLAS_PLATFORM: 'linux', XDG_DATA_HOME: join(linuxHome, '.local', 'share'), XDG_CONFIG_HOME: join(linuxHome, '.config'), XDG_STATE_HOME: join(linuxHome, '.local', 'state') };
  const linuxInstall = spawnSync('sh', [join(root, 'install.sh'), '--from', artifacts.get('0.1.0-test.1-lite'), '--yes', '--prefix-home', linuxHome, '--allowed-signers', signers], { cwd: root, env: linuxEnv, encoding: 'utf8' });
  assert.equal(linuxInstall.status, 0, linuxInstall.stderr);
  const linuxCli = join(linuxHome, '.local', 'share', 'brainatlas', 'current', 'packages', 'cli', 'bin', 'brainatlas.mjs');
  const linuxInit = spawnSync(process.execPath, [linuxCli, 'init', '--agents', 'fixture-agent', '--yes', '--json'], { cwd: root, env: linuxEnv, encoding: 'utf8' });
  assert.equal(linuxInit.status, 0, linuxInit.stderr);
  const changedAgentConfig = JSON.parse(await readFile(linuxAgentFile, 'utf8')); changedAgentConfig.userSetting = 'changed after install';
  await writeFile(linuxAgentFile, `${JSON.stringify(changedAgentConfig, null, 2)}\n`);
  const linuxUninstall = spawnSync(process.execPath, [linuxCli, 'uninstall', '--json'], { cwd: root, env: linuxEnv, encoding: 'utf8' });
  assert.equal(linuxUninstall.status, 0, linuxUninstall.stderr);
  assert.deepEqual(JSON.parse(await readFile(linuxAgentFile, 'utf8')), { userSetting: 'changed after install' });
  const expectedLinux = linuxBefore.map(item => item[0] === '.fixture-agent.json'
    ? [item[0], 'file', Buffer.from(`${JSON.stringify({ userSetting: 'changed after install' }, null, 2)}\n`).toString('base64'), item[3]]
    : item);
  assert.deepEqual(await snapshot(linuxHome), expectedLinux);
});
