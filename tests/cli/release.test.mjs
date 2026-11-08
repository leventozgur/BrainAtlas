// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { cp, copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDistribution, buildRelease, verifyRelease, extractRelease } from '../../release/build-release.mjs';
import { signRelease } from '../../release/sign.mjs';
import { extractVerifiedRelease, inspectReleaseArchive } from '../../packages/cli/src/archive.mjs';
import { cleanEnv } from './clean-env.mjs';

async function filesUnder(root, relative = '') {
  const entries = await readdir(join(root, relative), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await filesUnder(root, name));
    else files.push(name);
  }
  return files.sort();
}

test('full release is reproducible and rejects invalid checksum and signature', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ba-release-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const one = join(dir, 'one'), two = join(dir, 'two');
  const options = { version: '0.1.0-test.1', profile: 'full', builtAt: '1970-01-01T00:00:00.000Z' };
  const [archive, sums] = await buildRelease({ ...options, out: one });
  const [archive2] = await buildRelease({ ...options, out: two });
  assert.deepEqual(await readFile(archive), await readFile(archive2));
  const key = join(dir, 'key'); execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key], { env: cleanEnv(), shell: false });
  const pub = (await readFile(`${key}.pub`, 'utf8')).trim(); await writeFile(join(one, 'allowed_signers'), `brainatlas-release ${pub}\n`);
  const sig = signRelease(key, sums);
  assert.equal((await verifyRelease(archive, sums, sig, join(one, 'allowed_signers'))).version, options.version);
  const extracted = join(dir, 'extracted');
  await extractRelease(archive, sums, sig, extracted, join(one, 'allowed_signers'));
  assert.equal(JSON.parse(await readFile(join(extracted, 'release-manifest.json'))).version, options.version);
  await assert.rejects(extractRelease(archive, sums, sig, extracted, join(one, 'allowed_signers')), { code: 'EEXIST' });
  const original = await readFile(sums); const originalText = original.toString(); await writeFile(sums, `${originalText[0] === 'a' ? 'b' : 'a'}${originalText.slice(1)}`);
  await assert.rejects(verifyRelease(archive, sums, sig, join(one, 'allowed_signers')), { code: 'E_SHA_MISMATCH' });
  await writeFile(sums, original); await writeFile(sig, 'bad');
  await assert.rejects(verifyRelease(archive, sums, sig, join(one, 'allowed_signers')), { code: 'E_SIGNATURE_INVALID' });
});

test('signed archives reject traversal, absolute paths and links before extraction', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ba-unsafe-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const [archive, sums] = await buildRelease({ version: '0.1.0-test.3', profile: 'lite', out: dir });
  const original = gunzipSync(await readFile(archive));
  const key = join(dir, 'key'); execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key], { env: cleanEnv(), shell: false });
  const signers = join(dir, 'allowed_signers'); await writeFile(signers, `brainatlas-release ${(await readFile(`${key}.pub`, 'utf8')).trim()}\n`);
  let index = 0;
  for (const [name, type] of [['../escape', '0'], ['/escape', '0'], ['link', '2'], ['hardlink', '1']]) {
    const tar = Buffer.from(original); tar.fill(0, 0, 100); tar.write(name, 0); tar.write(type, 156);
    tar.fill(32, 148, 156); tar.write(tar.subarray(0, 512).reduce((a, b) => a + b, 0).toString(8).padStart(6, '0') + '\0 ', 148, 8);
    const bytes = gzipSync(tar); await writeFile(archive, bytes);
    await writeFile(sums, `${createHash('sha256').update(bytes).digest('hex')}  brainatlas-0.1.0-test.3-lite.tgz\n`);
    await rm(`${sums}.sig`, { force: true }); signRelease(key, sums);
    await assert.rejects(extractRelease(archive, sums, `${sums}.sig`, join(dir, 'out'), signers), { code: 'E_MANIFEST_INVALID' });
    await assert.rejects(extractVerifiedRelease(archive, join(dir, `cli-out-${index++}`), signers), { code: 'E_MANIFEST_INVALID' });
  }
});

test('lite release excludes modules while permitting third-party content', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ba-lite-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const [archive, sums] = await buildRelease({ version: '0.1.0-test.1', profile: 'lite', out: dir });
  assert.ok((await readFile(archive)).length > 0);
  const key = join(dir, 'key'); execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key], { env: cleanEnv(), shell: false });
  const signers = join(dir, 'allowed_signers'); await writeFile(signers, `brainatlas-release ${(await readFile(`${key}.pub`, 'utf8')).trim()}\n`); signRelease(key, sums);
  const { manifest, files } = await inspectReleaseArchive(archive, signers);
  assert.deepEqual(manifest.modules, []);
  assert.ok([...files.keys()].every(name => !name.startsWith('brainatlas-0.1.0-test.1/modules/')));
  assert.ok([...files].some(([name, bytes]) => name.includes('/node_modules/@modelcontextprotocol/sdk/') && /SYSTEMDRIVE/i.test(bytes.toString('utf8'))));
});

test('installer helper blocks an external symlinked root unless explicitly opted in', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ba-root-escape-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const [archive] = await buildRelease({ version: '0.1.0-test.root', profile: 'lite', out: dir });
  const home = join(dir, 'home'); const outside = join(dir, 'outside'); const dataRoot = join(home, '.local', 'share', 'brainatlas');
  await mkdir(join(home, '.local', 'share'), { recursive: true }); await mkdir(outside);
  await symlink(outside, dataRoot);
  const helper = join(process.cwd(), 'release', 'install-kit.mjs');
  const signers = join(dir, 'unused-signers');
  const run = (destination, extraEnv = {}) => spawnSync(process.execPath, [helper, '--archive', archive, '--destination', destination, '--allowed-signers', signers], {
    env: cleanEnv({ HOME: home, BRAINATLAS_INSECURE_SKIP_SIGNATURE: '1', ...extraEnv }), encoding: 'utf8', shell: false,
  });

  const rejected = run(join(dataRoot, 'releases', '.staging-rejected'));
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /E_PATH_ESCAPE/);
  assert.deepEqual(await readdir(outside), [], 'default rejection leaves the external target empty');

  const destination = join(dataRoot, 'releases', '.staging-allowed');
  await mkdir(join(outside, 'releases'));
  const allowed = run(destination, { BRAINATLAS_ALLOW_SYMLINKED_ROOT: '1' });
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.match(allowed.stderr, /WARNING: a BrainAtlas installation directory resolves outside HOME/);
  assert.equal(JSON.parse(await readFile(join(destination, 'release-manifest.json'), 'utf8')).version, '0.1.0-test.root');
});

test('offline distribution is reproducible, self-contained, and rejects changed kit files', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ba-kit-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const kit = join(dir, 'distribution');
  const cliBuild = spawnSync(process.execPath, ['release/build-release.mjs', '--version', '0.1.0-test.kit', '--out', kit], {
    cwd: process.cwd(), env: cleanEnv(), encoding: 'utf8', shell: false,
  });
  assert.equal(cliBuild.status, 0, 'builder CLI creates the distribution kit');
  const firstFiles = await filesUnder(kit);
  const firstBytes = new Map(await Promise.all(firstFiles.map(async name => [name, await readFile(join(kit, name))])));
  await buildDistribution({ version: '0.1.0-test.kit', out: kit });
  assert.deepEqual(await filesUnder(kit), firstFiles);
  for (const name of firstFiles) assert.deepEqual(await readFile(join(kit, name)), firstBytes.get(name));

  const sums = await readFile(join(kit, 'SHA256SUMS'), 'utf8');
  const entries = sums.trimEnd().split('\n').map(line => {
    const match = line.match(/^([a-f0-9]{64})  (.+)$/);
    assert.ok(match, 'checksum entry uses the expected format');
    return { digest: match[1], name: match[2] };
  });
  assert.ok(entries.some(entry => entry.name === 'install.sh'));
  assert.ok(entries.some(entry => entry.name === 'release/install-kit.mjs'));
  assert.ok(entries.some(entry => entry.name === 'release/allowed_signers'));
  assert.ok(entries.some(entry => entry.name === 'brainatlas-0.1.0-test.kit-lite.tgz'));
  assert.ok(entries.some(entry => entry.name === 'brainatlas-0.1.0-test.kit-full.tgz'));
  for (const entry of entries) assert.equal(createHash('sha256').update(await readFile(join(kit, entry.name))).digest('hex'), entry.digest);

  const key = join(dir, 'key');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key], { env: cleanEnv(), shell: false });
  const signers = join(dir, 'allowed_signers');
  await writeFile(signers, `brainatlas-release ${(await readFile(`${key}.pub`, 'utf8')).trim()}\n`);
  signRelease(key, join(kit, 'SHA256SUMS'));

  const copied = join(dir, 'copied-kit');
  await cp(kit, copied, { recursive: true });
  const elsewhere = join(dir, 'elsewhere'); const home = join(dir, 'fake-home'); const temp = join(dir, 'tmp');
  const vault = join(dir, 'vault');
  await Promise.all([mkdir(elsewhere), mkdir(home), mkdir(temp)]);
  const install = (...args) => spawnSync('sh', [join(copied, 'install.sh'), ...args], {
    cwd: elsewhere,
    env: cleanEnv({ HOME: home, TMPDIR: temp, XDG_DATA_HOME: join(home, '.local', 'share'), XDG_CONFIG_HOME: join(home, '.config'), XDG_STATE_HOME: join(home, '.local', 'state'), BRAINATLAS_PLATFORM: 'linux', BRAINATLAS_RELEASE_SOURCE: join(dir, 'source-unavailable') }),
    encoding: 'utf8',
    shell: false,
  });
  const args = ['--from', join(copied, 'brainatlas-0.1.0-test.kit-lite.tgz'), '--allowed-signers', signers, '--vault', vault, '--yes'];

  const helper = join(copied, 'release', 'install-kit.mjs');
  await writeFile(helper, Buffer.concat([await readFile(helper), Buffer.from('x')]));
  const helperTamper = install(...args);
  assert.notEqual(helperTamper.status, 0);
  assert.match(helperTamper.stderr, /E_SHA_MISMATCH/);
  await copyFile(join(kit, 'release', 'install-kit.mjs'), helper);

  const installer = join(copied, 'install.sh');
  await writeFile(installer, Buffer.concat([await readFile(installer), Buffer.from('x')]));
  const installerTamper = install(...args);
  assert.notEqual(installerTamper.status, 0);
  assert.match(installerTamper.stderr, /E_SHA_MISMATCH/);
  await copyFile(join(kit, 'install.sh'), installer);

  const archive = join(copied, 'brainatlas-0.1.0-test.kit-lite.tgz');
  await writeFile(archive, Buffer.concat([await readFile(archive), Buffer.from('x')]));
  const archiveTamper = install(...args);
  assert.notEqual(archiveTamper.status, 0);
  assert.match(archiveTamper.stderr, /E_SHA_MISMATCH/);
  await copyFile(join(kit, 'brainatlas-0.1.0-test.kit-lite.tgz'), archive);

  const installed = install(...args);
  assert.equal(installed.status, 0, 'copied distribution installs without the source tree');
  const cli = join(home, '.local', 'share', 'brainatlas', 'current', 'packages', 'cli', 'bin', 'brainatlas.mjs');
  const doctor = spawnSync(process.execPath, [cli, 'doctor', '--json'], {
    cwd: elsewhere,
    env: cleanEnv({ HOME: home, TMPDIR: temp, XDG_DATA_HOME: join(home, '.local', 'share'), XDG_CONFIG_HOME: join(home, '.config'), XDG_STATE_HOME: join(home, '.local', 'state'), BRAINATLAS_PLATFORM: 'linux', BRAINATLAS_ALLOWED_SIGNERS: signers }),
    encoding: 'utf8',
    shell: false,
  });
  assert.equal(doctor.status, 0, 'installed CLI doctor succeeds');
  assert.equal(JSON.parse(doctor.stdout).ok, true);

  const linkedHome = join(dir, 'fake-home-linked'); const linkedOutside = join(dir, 'linked-outside');
  const linkedDataHome = join(linkedHome, '.local', 'share');
  await mkdir(linkedDataHome, { recursive: true }); await mkdir(linkedOutside);
  await symlink(linkedOutside, join(linkedDataHome, 'brainatlas'));
  const linkedInstall = spawnSync('sh', [join(copied, 'install.sh'), '--from', archive, '--allowed-signers', signers, '--vault', join(dir, 'linked-vault'), '--yes', '--allow-symlinked-root'], {
    cwd: elsewhere,
    env: cleanEnv({ HOME: linkedHome, TMPDIR: temp, XDG_DATA_HOME: linkedDataHome, XDG_CONFIG_HOME: join(linkedHome, '.config'), XDG_STATE_HOME: join(linkedHome, '.local', 'state'), BRAINATLAS_PLATFORM: 'linux' }),
    encoding: 'utf8', shell: false,
  });
  assert.equal(linkedInstall.status, 0, linkedInstall.stderr);
  assert.match(linkedInstall.stderr, /WARNING: a BrainAtlas installation directory resolves outside HOME/);
  assert.ok((await readdir(linkedOutside)).includes('current'), 'the explicit installer opt-in follows the symlinked root');
});
