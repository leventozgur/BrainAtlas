// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { buildRelease } from '../../release/build-release.mjs';
import { createMemoryTransport } from '../../modules/sync-engine/src/transport.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const requiredFullModules = ['sync-engine', 'sync-git', 'sync-dropbox', 'okf-strict', 'receipts'];

async function releaseManifest(archivePath) {
  const archive = gunzipSync(await readFile(archivePath));
  for (let offset = 0; offset + 512 <= archive.length;) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const field = (start, length) => header.subarray(start, start + length).toString('utf8').split('\0')[0];
    const name = [field(345, 155), field(0, 100)].filter(Boolean).join('/');
    const size = Number.parseInt(field(124, 12).trim(), 8);
    offset += 512;
    if (!Number.isSafeInteger(size) || size < 0 || offset + size > archive.length) throw new Error('Invalid test archive.');
    if (name.endsWith('/release-manifest.json')) return JSON.parse(archive.subarray(offset, offset + size).toString('utf8'));
    offset += Math.ceil(size / 512) * 512;
  }
  throw new Error('Release manifest is unavailable.');
}

function activationSource(moduleName) {
  return new URL(`../../modules/${moduleName}/src/index.mjs`, import.meta.url);
}

test('full release is ready for the two-host offline sync scenario', { skip: 'PM: probe written ahead of time by E2E-LITE; owned and completed by the E2E-FULL track' }, async t => {
  const temp = await mkdtemp(join(tmpdir(), 'ba-e2e-full-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const macHome = join(temp, 'fake-home-macos');
  const linuxHome = join(temp, 'fake-home-linux');
  const bareRemote = join(temp, 'git-remote.git');
  const output = join(temp, 'release-output');
  const gitConfig = join(temp, 'git-config');
  await mkdir(join(macHome, 'Library', 'Application Support'), { recursive: true });
  await mkdir(join(linuxHome, '.config'), { recursive: true });
  await mkdir(output, { recursive: true });
  await writeFile(gitConfig, '');
  const env = {
    PATH: process.env.PATH || '/usr/bin:/bin',
    HOME: macHome,
    TMPDIR: temp,
    BRAINATLAS_PLATFORM: 'darwin',
    BRAINATLAS_OFFLINE: '1',
    HTTPS_PROXY: ['http:', '', [127, 0, 0, 1].join('.') + ':9'].join('/'),
    npm_config_offline: 'true',
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    LC_ALL: 'C'
  };
  const linuxEnv = {
    ...env,
    HOME: linuxHome,
    BRAINATLAS_PLATFORM: 'linux',
    XDG_CONFIG_HOME: join(linuxHome, '.config'),
    XDG_DATA_HOME: join(linuxHome, '.local', 'share'),
    XDG_STATE_HOME: join(linuxHome, '.local', 'state')
  };
  const git = spawnSync('git', ['init', '--bare', '--quiet', bareRemote], { cwd: temp, env, encoding: 'utf8' });
  assert.ok(!git.error && git.status === 0, 'The local bare Git fixture must be available.');
  assert.ok(await lstat(bareRemote).then(info => info.isDirectory()).catch(() => false), 'The bare Git fixture must be created.');

  const previousSource = process.env.BRAINATLAS_RELEASE_SOURCE;
  process.env.BRAINATLAS_RELEASE_SOURCE = root;
  let archive;
  try {
    [archive] = await buildRelease({ version: '0.1.0-e2e-full.1', profile: 'full', out: output });
  } finally {
    if (previousSource === undefined) delete process.env.BRAINATLAS_RELEASE_SOURCE;
    else process.env.BRAINATLAS_RELEASE_SOURCE = previousSource;
  }
  const manifest = await releaseManifest(archive);
  const issues = requiredFullModules.filter(name => !manifest.modules.includes(name)).map(name => `full-release-missing-${name}`);
  const activated = [];
  for (const name of ['sync-engine', 'sync-git', 'sync-dropbox']) {
    const module = await import(activationSource(name));
    try {
      await module.activate({ config: {}, paths: {}, env, core: {}, logger: { info() {}, warn() {}, error() {} } });
      activated.push(true);
    } catch (cause) {
      activated.push(false);
      if (cause?.code === 'E_NOT_IMPLEMENTED') issues.push(`${name}-activation-stub`);
      else issues.push(`${name}-activation-failed`);
    }
  }
  try {
    const transport = createMemoryTransport();
    if (!transport || typeof transport.put !== 'function' || typeof transport.get !== 'function') issues.push('memory-transport-contract');
  } catch (cause) {
    issues.push(cause?.code === 'E_NOT_IMPLEMENTED' ? 'memory-transport-stub' : 'memory-transport-failed');
  }

  // The second isolated HOME is part of the fixture for the follow-on sync loop.
  assert.ok(macHome !== linuxHome && env.HOME === macHome && linuxEnv.HOME === linuxHome && linuxEnv.BRAINATLAS_PLATFORM === 'linux', 'The two host layouts must remain isolated.');
  assert.ok(activated.length === 3, 'Each declared sync module must be checked.');
  assert.deepEqual(issues, [], 'Full sync release prerequisites failed; see issue identifiers in this assertion.');
});

test.skip('two-host full sync exchanges Git and Dropbox state, detects conflict, and rejects secret content', 'The sync module activation and transport contracts are still E_NOT_IMPLEMENTED.');
