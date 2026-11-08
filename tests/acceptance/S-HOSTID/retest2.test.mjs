// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, link, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveHostId } from '../../../modules/sync-engine/src/index.mjs';
import { createGitTransport } from '../../../modules/sync-git/src/index.mjs';

test('legacy identity remains below env and config and agrees with git status', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hostid-retest2-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = { sync: { options: { hostId: 'config-id' } } };
  for (const [env, cfg, expected] of [
    [{ BRAINATLAS_HOST_ID: 'env-id' }, config, 'env-id'],
    [{}, config, 'config-id'],
    [{}, {}, 'legacy-id'],
  ]) {
    const options = { stateDir: join(root, expected), remote: join(root, 'remote'), env, config: cfg, hostId: 'legacy-id' };
    assert.equal(await resolveHostId(options), expected);
    assert.equal((await createGitTransport(options).status()).hostId, expected);
    await assert.rejects(stat(join(options.stateDir, 'sync', 'host-id')), { code: 'ENOENT' });
  }
});

test('a hard-linked identity is rejected even when its contents and mode are valid', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hostid-retest2-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, 'state', 'sync'), outside = join(root, 'outside');
  await mkdir(dir, { recursive: true });
  await writeFile(outside, 'valid-id\n', { mode: 0o600 });
  await link(outside, join(dir, 'host-id'));
  await assert.rejects(resolveHostId({ stateDir: join(root, 'state'), env: {} }), { code: 'E_INVALID_PATH' });
  assert.equal((await stat(outside)).nlink, 2);
});
