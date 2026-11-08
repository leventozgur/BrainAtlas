// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';

const root = resolve(new URL('../../..', import.meta.url).pathname);
const version = '0.1.0-acceptance.kit';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const run = (cmd, args, options = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...options });
async function files(dir, rel = '') {
  const result = [];
  for (const e of await readdir(join(dir, rel), { withFileTypes: true })) {
    const name = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) result.push(...await files(dir, name)); else result.push(name);
  }
  return result.sort();
}

test('offline release kit acceptance', { timeout: 180000 }, async t => {
  const base = await mkdtemp(join(tmpdir(), 'r-kit-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = join(base, 'home'), work = join(base, 'elsewhere'), temp = join(base, 'tmp');
  await Promise.all([home, work, temp].map(p => mkdir(p)));
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('BRAINATLAS_') && !k.startsWith('XDG_')));
  Object.assign(env, { HOME: home, TMPDIR: temp, XDG_DATA_HOME: join(home, 'data'), XDG_CONFIG_HOME: join(home, 'config'), XDG_STATE_HOME: join(home, 'state'), BRAINATLAS_PLATFORM: 'linux' });
  const one = join(base, 'build-one'), two = join(base, 'build-two');
  const build = out => run(process.execPath, [join(root, 'release/build-release.mjs'), '--version', version, '--out', out], { cwd: work, env });
  const b1 = build(one), b2 = build(two);
  assert.equal(b1.status, 0, b1.stderr); assert.equal(b2.status, 0, b2.stderr);
  const names = await files(one), sumsPath = join(one, 'SHA256SUMS');
  await t.test('two independent builds are byte-identical and checksums cover every kit file', async () => {
    assert.deepEqual(await files(two), names);
    for (const name of names) assert.deepEqual(await readFile(join(one, name)), await readFile(join(two, name)), name);
    const lines = (await readFile(sumsPath, 'utf8')).trimEnd().split('\n');
    const entries = new Map(lines.map(line => { const m = /^([a-f0-9]{64})  (.+)$/.exec(line); assert.ok(m, line); return [m[2], m[1]]; }));
    assert.equal(entries.size, lines.length);
    assert.deepEqual([...entries.keys()].sort(), names.filter(n => n !== 'SHA256SUMS'));
    for (const [name, sha] of entries) assert.equal(digest(await readFile(join(one, name))), sha, name);
  });
  await t.test('invalid release version leaves existing output intact', async () => {
    const before = new Map(await Promise.all(names.map(async name => [name, await readFile(join(one, name))])));
    const r = run(process.execPath, [join(root, 'release/build-release.mjs'), '--version', '../escape', '--out', one], { cwd: work, env });
    assert.notEqual(r.status, 0); assert.match(r.stderr, /E_MANIFEST_INVALID/);
    assert.deepEqual(await files(one), names);
    for (const name of names) assert.deepEqual(await readFile(join(one, name)), before.get(name));
    assert.deepEqual(await readdir(work), []);
  });
  const key = join(base, 'key');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key], { env });
  const signers = join(base, 'signers');
  await writeFile(signers, `brainatlas-release ${(await readFile(`${key}.pub`, 'utf8')).trim()}\n`);
  const sign = dir => { const p = join(dir, 'SHA256SUMS'); return execFileSync('ssh-keygen', ['-Y', 'sign', '-n', 'brainatlas-release', '-f', key, p], { env, stdio: 'ignore' }); };
  sign(one);
  const kit = join(base, 'isolated-kit'); await cp(one, kit, { recursive: true });
  const archiveName = `brainatlas-${version}-lite.tgz`;
  const secret = ['sk', 'test' + 'x'.repeat(24)].join('-');
  const vault = join(base, `vault-${secret}`);
  const install = (extra = [], from = join(kit, archiveName)) => run('sh', [join(kit, 'install.sh'), '--from', from, '--allowed-signers', signers, '--vault', vault, '--yes', ...extra], { cwd: work, env });
  await t.test('one-byte modifications to every listed file are rejected', async () => {
    for (const name of names.filter(n => n !== 'SHA256SUMS')) {
      const path = join(kit, name), bytes = await readFile(path), modified = Buffer.from(bytes);
      // Change a byte in the installer's comment so its shell syntax remains valid.
      if (name === 'install.sh') modified[modified.indexOf(Buffer.from('SPDX'))] ^= 1;
      else modified[Math.floor(modified.length / 2)] ^= 1;
      await writeFile(path, modified);
      const r = install();
      assert.notEqual(r.status, 0, name);
      assert.match(r.stderr, /E_SHA_MISMATCH/, name);
      await writeFile(path, bytes);
    }
  });
  await t.test('missing signature, untrusted signer, invalid profile, and missing archive fail safely', async () => {
    const sig = join(kit, 'SHA256SUMS.sig'), bytes = await readFile(sig);
    await rm(sig); let r = install(); assert.notEqual(r.status, 0); assert.match(r.stderr, /E_SIGNATURE_INVALID/); await writeFile(sig, bytes);
    const bad = join(base, 'bad-signers'); await writeFile(bad, 'invalid\n');
    r = install(['--allowed-signers', bad]); assert.notEqual(r.status, 0); assert.match(r.stderr, /E_SIGNATURE_INVALID/);
    r = install(['--profile', 'full']); assert.notEqual(r.status, 0); assert.match(r.stderr, /E_PROFILE_MISMATCH/);
    r = install([], join(kit, 'missing.tgz')); assert.notEqual(r.status, 0); assert.match(r.stderr, /E_ARCHIVE_READ/);
  });
  await t.test('signed archives with traversal or symlink entries are rejected before extraction', async () => {
    const archive = join(kit, archiveName), original = await readFile(archive), originalSums = await readFile(join(kit, 'SHA256SUMS')), sig = join(kit, 'SHA256SUMS.sig'), originalSig = await readFile(sig);
    for (const [name, type] of [['../escape', '0'], ['escape', '2']]) {
      const tar = gunzipSync(original); tar.fill(0, 0, 100); tar.write(name, 0); tar.write(type, 156); tar.fill(32, 148, 156);
      tar.write(tar.subarray(0, 512).reduce((a, b) => a + b, 0).toString(8).padStart(6, '0') + '\0 ', 148, 8);
      const bad = gzipSync(tar); await writeFile(archive, bad);
      await writeFile(join(kit, 'SHA256SUMS'), originalSums.toString().replace(new RegExp(`[a-f0-9]{64}(?=  ${archiveName.replaceAll('.', '\\.')}\\n)`), digest(bad)));
      await rm(sig); sign(kit);
      const r = install(); assert.notEqual(r.status, 0, name); assert.match(r.stderr, /E_MANIFEST_INVALID/);
      assert.equal((await readdir(home)).length, 0); assert.equal((await readdir(work)).length, 0);
    }
    await writeFile(archive, original); await writeFile(join(kit, 'SHA256SUMS'), originalSums); await writeFile(sig, originalSig);
  });
  await t.test('a pre-existing installation directory symlink cannot redirect writes outside HOME', async () => {
    const otherHome = join(base, 'symlink-home'), outside = join(base, 'outside');
    await mkdir(join(otherHome, 'data'), { recursive: true }); await mkdir(outside);
    await symlink(outside, join(otherHome, 'data', 'brainatlas'));
    const env2 = { ...env, HOME: otherHome, XDG_DATA_HOME: join(otherHome, 'data'), XDG_CONFIG_HOME: join(otherHome, 'config'), XDG_STATE_HOME: join(otherHome, 'state') };
    const r = run('sh', [join(kit, 'install.sh'), '--from', join(kit, archiveName), '--allowed-signers', signers, '--vault', join(otherHome, 'vault'), '--yes'], { cwd: work, env: env2 });
    assert.deepEqual(await readdir(outside), [], 'installation must not write through a symlink outside HOME');
    assert.notEqual(r.status, 0, 'redirected installation must fail');
  });
  await t.test('external installation roots require explicit opt-in; external XDG and .local remain supported', async () => {
    for (const mode of ['flag', 'environment', 'external-xdg', 'local-symlink']) {
      const h = join(base, `home-${mode}`), outside = join(base, `outside-${mode}`);
      await mkdir(h); await mkdir(outside);
      const e = { ...env, HOME: h, XDG_DATA_HOME: join(h, 'data'), XDG_CONFIG_HOME: join(h, 'config'), XDG_STATE_HOME: join(h, 'state') };
      const extra = [];
      if (mode === 'flag' || mode === 'environment') {
        await mkdir(e.XDG_DATA_HOME); await symlink(outside, join(e.XDG_DATA_HOME, 'brainatlas'));
        if (mode === 'flag') extra.push('--allow-symlinked-root');
        else e.BRAINATLAS_ALLOW_SYMLINKED_ROOT = '1';
      } else if (mode === 'external-xdg') e.XDG_DATA_HOME = outside;
      else { delete e.XDG_DATA_HOME; await symlink(outside, join(h, '.local')); }
      const r = run('sh', [join(kit, 'install.sh'), '--from', join(kit, archiveName), '--allowed-signers', signers, '--vault', join(h, 'vault'), '--yes', ...extra], { cwd: work, env: e });
      assert.equal(r.status, 0, `${mode}: ${r.stderr}`);
      const data = mode === 'flag' || mode === 'environment' ? outside : mode === 'external-xdg' ? join(outside, 'brainatlas') : join(outside, 'share/brainatlas');
      const d = run(process.execPath, [join(data, 'current/packages/cli/bin/brainatlas.mjs'), 'doctor', '--json'], { cwd: work, env: { ...e, BRAINATLAS_ALLOWED_SIGNERS: signers } });
      assert.equal(d.status, 0, `${mode}: ${d.stderr}`); assert.equal(JSON.parse(d.stdout).ok, true, mode);
    }
  });
  await t.test('copied kit installs from a different cwd, doctor succeeds and output does not disclose vault secret', async () => {
    const r = install(); assert.equal(r.status, 0, r.stderr); assert.ok(!(r.stdout + r.stderr).includes(secret));
    const cli = join(home, 'data/brainatlas/current/packages/cli/bin/brainatlas.mjs');
    const d = run(process.execPath, [cli, 'doctor', '--json'], { cwd: work, env: { ...env, BRAINATLAS_ALLOWED_SIGNERS: signers } });
    assert.equal(d.status, 0, d.stderr); assert.equal(JSON.parse(d.stdout).ok, true);
    assert.ok(!(d.stdout + d.stderr).includes(secret));
    assert.deepEqual(await readdir(work), []);
    const repeat = install(); assert.notEqual(repeat.status, 0); assert.match(repeat.stderr, /E_RELEASE_EXISTS/);
  });
});
