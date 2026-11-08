// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commands, createMemoryTransport, createSyncEngine, resolveHostId } from '../../../modules/sync-engine/src/index.mjs';

async function testRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'sync-host-id-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('host identity follows env, config and persistent generated precedence', async (t) => {
  const root = await testRoot(t);
  const stateDir = join(root, 'state');
  const config = { sync: { options: { hostId: 'Config_Host' } } };

  assert.equal(await resolveHostId({ stateDir, env: { BRAINATLAS_HOST_ID: 'Env.Host' }, config }), 'env-host');
  assert.equal(await resolveHostId({ stateDir, env: {}, config }), 'config-host');

  const first = await resolveHostId({ stateDir, env: {}, config: { sync: { options: {} } } });
  const again = await resolveHostId({ stateDir, env: {}, config: {} });
  const other = await resolveHostId({ stateDir: join(root, 'other-state'), env: {}, config: {} });
  assert.match(first, /^[a-z0-9-]{1,32}$/);
  assert.equal(again, first);
  assert.notEqual(other, first);

  const info = await lstat(join(stateDir, 'sync', 'host-id'));
  assert.equal(info.mode & 0o777, 0o600);
});

test('simultaneous first use creates one private host identity', async (t) => {
  const root = await testRoot(t);
  const stateDir = join(root, 'state');
  const identities = await Promise.all(Array.from({ length: 8 }, () => resolveHostId({ stateDir, env: {} })));
  assert.equal(new Set(identities).size, 1);
  assert.deepEqual(await readdir(join(stateDir, 'sync')), ['host-id']);
});

test('two env-free hosts keep conflict and deletion ownership distinct', async (t) => {
  const root = await testRoot(t);
  const transport = createMemoryTransport();

  async function host(name) {
    const vaultPath = join(root, name, 'vault');
    const stateDir = join(root, name, 'state');
    await mkdir(vaultPath, { recursive: true });
    const config = { vault: { path: vaultPath }, sync: { options: {} } };
    const env = {};
    const context = { config, paths: { stateDir }, transport, env };
    const engine = createSyncEngine({ vaultPath, stateDir, config, transport, env });
    const status = await commands.sync(context, ['status', '--json']);
    return { vaultPath, stateDir, engine, context, hostId: status.hostId };
  }

  const first = await host('replica-a');
  const second = await host('replica-b');
  assert.notEqual(first.hostId, second.hostId);
  assert.equal((await first.engine.status()).hostId, first.hostId);
  assert.equal((await second.engine.status()).hostId, second.hostId);

  const pagePath = 'wiki/page.md';
  const page = join(first.vaultPath, pagePath);
  await mkdir(join(first.vaultPath, 'wiki'), { recursive: true });
  await writeFile(page, 'base\n');
  await first.engine.run();
  await second.engine.run();
  await writeFile(page, 'edit from replica a\n');
  await writeFile(join(second.vaultPath, pagePath), 'edit from replica b\n');
  await first.engine.run();
  const conflict = await second.engine.run();
  assert.equal(conflict.status, 'CONFLICT');
  const names = await readdir(join(second.vaultPath, 'wiki'));
  assert.ok(names.some((name) => name.includes(`.conflict-${second.hostId}-`)));
  assert.equal(JSON.parse(await readFile(join(second.stateDir, 'sync', 'journal.json'), 'utf8')).hostId, second.hostId);

  const deletePath = 'wiki/delete-me.md';
  await writeFile(join(first.vaultPath, deletePath), 'shared\n');
  await first.engine.run();
  await second.engine.run();
  await rm(join(first.vaultPath, deletePath));
  await first.engine.run();
  await second.engine.run();
  const requests = await transport.list('.brainatlas-sync/meta/pending-deletions/');
  const request = JSON.parse(Buffer.from((await transport.get(requests[0].path)).bytes).toString('utf8'));
  assert.equal(request.path, deletePath);
  assert.equal(request.requestedBy, first.hostId);

  assert.deepEqual(await second.engine.approveDeletes([deletePath]), { approved: [deletePath] });
  const tombstones = await transport.list('.brainatlas-sync/meta/tombstones/');
  const tombstone = JSON.parse(Buffer.from((await transport.get(tombstones[0].path)).bytes).toString('utf8'));
  assert.equal(tombstone.path, deletePath);
  assert.equal(tombstone.approvedBy, second.hostId);
  assert.notEqual(request.requestedBy, tombstone.approvedBy);
  assert.equal(JSON.parse(await readFile(join(second.stateDir, 'sync', 'journal.json'), 'utf8')).hostId, second.hostId);
});
