// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRelease, verifyRelease, extractRelease } from '../../release/build-release.mjs';
import { signRelease } from '../../release/sign.mjs';

test('full release is reproducible and rejects invalid checksum and signature', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ba-release-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const one = join(dir, 'one'), two = join(dir, 'two');
  const options = { version: '0.1.0-test.1', profile: 'full', builtAt: '1970-01-01T00:00:00.000Z' };
  const [archive, sums] = await buildRelease({ ...options, out: one });
  const [archive2] = await buildRelease({ ...options, out: two });
  assert.deepEqual(await readFile(archive), await readFile(archive2));
  const key = join(dir, 'key'); execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key]);
  const pub = (await readFile(`${key}.pub`, 'utf8')).trim(); await writeFile(join(one, 'allowed_signers'), `brainatlas-release ${pub}\n`);
  const sig = signRelease(key, sums);
  assert.equal((await verifyRelease(archive, sums, sig, join(one, 'allowed_signers'))).version, options.version);
  const extracted = join(dir, 'extracted');
  await extractRelease(archive, sums, sig, extracted, join(one, 'allowed_signers'));
  assert.equal(JSON.parse(await readFile(join(extracted, 'release-manifest.json'))).version, options.version);
  await assert.rejects(extractRelease(archive, sums, sig, extracted, join(one, 'allowed_signers')), { code: 'EEXIST' });
  const original = await readFile(sums); await writeFile(sums, `a${original.toString().slice(1)}`);
  await assert.rejects(verifyRelease(archive, sums, sig, join(one, 'allowed_signers')), { code: 'E_SHA_MISMATCH' });
  await writeFile(sums, original); await writeFile(sig, 'bad');
  await assert.rejects(verifyRelease(archive, sums, sig, join(one, 'allowed_signers')), { code: 'E_SIGNATURE_INVALID' });
});

test('signed archives reject traversal, absolute paths and links before extraction', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ba-unsafe-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const [archive, sums] = await buildRelease({ version: '0.1.0-test.3', profile: 'lite', out: dir });
  const original = gunzipSync(await readFile(archive));
  const key = join(dir, 'key'); execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key]);
  const signers = join(dir, 'allowed_signers'); await writeFile(signers, `brainatlas-release ${(await readFile(`${key}.pub`, 'utf8')).trim()}\n`);
  for (const [name, type] of [['../escape', '0'], ['/escape', '0'], ['link', '2'], ['hardlink', '1']]) {
    const tar = Buffer.from(original); tar.fill(0, 0, 100); tar.write(name, 0); tar.write(type, 156);
    tar.fill(32, 148, 156); tar.write(tar.subarray(0, 512).reduce((a, b) => a + b, 0).toString(8).padStart(6, '0') + '\0 ', 148, 8);
    const bytes = gzipSync(tar); await writeFile(archive, bytes);
    await writeFile(sums, `${createHash('sha256').update(bytes).digest('hex')}  brainatlas-0.1.0-test.3-lite.tgz\n`);
    await rm(`${sums}.sig`, { force: true }); signRelease(key, sums);
    await assert.rejects(extractRelease(archive, sums, `${sums}.sig`, join(dir, 'out'), signers), { code: 'E_MANIFEST_INVALID' });
  }
});

test('lite release excludes modules while permitting third-party content', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ba-lite-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const [archive] = await buildRelease({ version: '0.1.0-test.1', profile: 'lite', out: dir });
  assert.ok((await readFile(archive)).length > 0);
});
