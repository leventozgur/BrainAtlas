// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, link, stat, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveHostId } from '../../../modules/sync-engine/src/index.mjs';
import { createGitTransport, commands } from '../../../modules/sync-git/src/index.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'hostid-retest-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('host identity cannot change permissions of a hard-linked file outside stateDir', async (t) => {
  const root = await fixture(t), stateDir = join(root, 'state');
  const outside = join(root, 'outside');
  await mkdir(join(stateDir, 'sync'), { recursive: true });
  await writeFile(outside, 'existing-id\n', { mode: 0o644 });
  await link(outside, join(stateDir, 'sync', 'host-id'));
  let error;
  try { await resolveHostId({ stateDir, env: {} }); } catch (caught) { error = caught; }
  assert.equal((await stat(outside)).mode & 0o777, 0o644, 'outside file mode must remain unchanged');
  assert.equal(await readFile(outside, 'utf8'), 'existing-id\n');
  assert.ok(error, 'hard-linked identity must be rejected');
});

test('git status includes the resolved identity for the legacy constructor option', async (t) => {
  const root = await fixture(t);
  const transport = createGitTransport({ stateDir: join(root, 'state'), remote: join(root, 'remote'), env: {}, hostId: 'legacy-id' });
  const status = await commands.status(['--json'], { config: { sync: { transport: 'git' } }, transport });
  assert.equal(status.hostId, 'legacy-id');
});
