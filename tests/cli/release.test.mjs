// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRelease, verifyRelease } from '../../release/build-release.mjs';
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
  const original = await readFile(sums); await writeFile(sums, `a${original.toString().slice(1)}`);
  await assert.rejects(verifyRelease(archive, sums, sig, join(one, 'allowed_signers')), { code: 'E_SHA_MISMATCH' });
  await writeFile(sums, original); await writeFile(sig, 'bad');
  await assert.rejects(verifyRelease(archive, sums, sig, join(one, 'allowed_signers')), { code: 'E_SIGNATURE_INVALID' });
});

test('lite purity guard rejects forbidden content in production dependencies', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ba-lite-')); t.after(() => rm(dir, { recursive: true, force: true }));
  await assert.rejects(buildRelease({ version: '0.1.0-test.1', profile: 'lite', out: dir }), { code: 'E_LITE_PURITY' });
});
