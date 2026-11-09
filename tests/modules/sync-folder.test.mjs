// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readModuleManifest, resolveModuleOrder } from '../../packages/core/src/modules/index.mjs';
import { atomicWriteFile } from '../../packages/core/src/util/index.mjs';
import { activate, createFolderTransport, isFolderConflictCopy } from '../../modules/sync-folder/src/index.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'sync-folder-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vault = join(root, 'vault');
  const share = join(root, 'shared-folder');
  await Promise.all([mkdir(vault), mkdir(share)]);
  const create = () => createFolderTransport({ path: share, vaultPath: vault });
  return { root, vault, share, create };
}

test('folder transport shares bytes between hosts and uses content plus mtime revisions', async (t) => {
  const fx = await fixture(t);
  const hostA = fx.create();
  const hostB = fx.create();
  assert.deepEqual(hostA.capabilities, { cas: false, mode: 'object' });
  const bytes = Uint8Array.from([0, 255, 1, 128, 42]);
  const created = await hostA.put('wiki/data.bin', bytes, { ifAbsent: true });
  const read = await hostB.get('wiki/data.bin');
  assert.deepEqual(read.bytes, bytes);
  assert.equal(read.rev, created.rev);
  assert.deepEqual((await hostB.list('wiki')).map(({ path }) => path), ['wiki/data.bin']);
  await assert.rejects(hostB.put('wiki/data.bin', Buffer.from('stale'), { ifRev: 'stale-revision' }), { code: 'E_CONFLICT' });
  const updated = await hostB.put('wiki/data.bin', Buffer.from('updated\n'), { ifRev: read.rev });
  assert.notEqual(updated.rev, read.rev);
  assert.equal(Buffer.from((await hostA.get('wiki/data.bin')).bytes).toString(), 'updated\n');
  await hostA.delete('wiki/data.bin', { ifRev: updated.rev });
  assert.equal(await hostB.get('wiki/data.bin'), null);
});

test('concurrent conditional writes recheck the shared revision where possible', async (t) => {
  const fx = await fixture(t);
  const hostA = fx.create();
  const hostB = fx.create();
  const initial = await hostA.put('shared.md', Buffer.from('base'), { ifAbsent: true });
  const results = await Promise.allSettled([
    hostA.put('shared.md', Buffer.from('from-a'), { ifRev: initial.rev }),
    hostB.put('shared.md', Buffer.from('from-b'), { ifRev: initial.rev }),
  ]);
  assert.ok(results.some((result) => result.status === 'fulfilled'));
  const final = await hostA.get('shared.md');
  assert.ok(['from-a', 'from-b'].includes(Buffer.from(final.bytes).toString()));
  assert.equal(hostA.capabilities.cas, false, 'concurrent filesystem races remain best effort');
});

test('folder configuration requires an absolute path outside the vault', async (t) => {
  const fx = await fixture(t);
  await assert.rejects(createFolderTransport({ path: 'relative-share', vaultPath: fx.vault }).list(), { code: 'E_INVALID_PATH' });
  await assert.rejects(createFolderTransport({ path: join(fx.vault, 'sync'), vaultPath: fx.vault }).list(), { code: 'E_INVALID_PATH' });
});

test('provider conflict copies are surfaced as degraded status and never folded into another object', async (t) => {
  const fx = await fixture(t);
  const transport = fx.create();
  await transport.put('notes/page.md', Buffer.from('canonical\n'), { ifAbsent: true });
  const conflicts = [
    'notes/page 2.md',
    'notes/page (conflicted copy 2026-11-08).md',
    'notes/page (1).md',
    'notes/page-HOST.md',
    'notes/page.sync-conflict-20261108-101112-ABC1234.md',
    'notes/page (çeşitli çakışan kopya).md',
  ];
  for (const path of conflicts) assert.equal(isFolderConflictCopy(path), true, path);
  for (const path of ['meeting-notes.md', 'notes-final-draft.md', 'notes-AB.md']) {
    assert.equal(isFolderConflictCopy(path), false, path);
  }
  for (const [index, path] of conflicts.entries()) await writeFile(join(fx.share, ...path.split('/')), `copy ${index}`);
  await writeFile(join(fx.share, 'notes', 'placeholder.md.icloud'), 'placeholder');
  await writeFile(join(fx.share, 'notes', '~$draft.md'), 'temporary');
  await writeFile(join(fx.share, 'notes', 'partial.tmp'), 'temporary');
  await writeFile(join(fx.share, 'notes', '.syncthing.partial'), 'temporary');
  const listed = await transport.list();
  assert.equal(listed.length, conflicts.length + 1);
  assert.deepEqual(listed.filter((row) => row.conflict).map((row) => row.path).sort(), [...conflicts].sort());
  const status = await transport.status();
  assert.equal(status.status, 'degraded');
  assert.equal(status.code, 'E_DEGRADED');
  assert.equal(status.cas, false);
  assert.equal(status.conflictCount, conflicts.length);
  assert.equal(await readFile(join(fx.share, 'notes/page.md'), 'utf8'), 'canonical\n');
});

test('folder writes reject traversal and symlink escapes', async (t) => {
  const fx = await fixture(t);
  const transport = fx.create();
  await assert.rejects(transport.get('../outside'), { code: 'E_INVALID_PATH' });
  await assert.rejects(transport.put('a/../outside', Buffer.from('x'), { ifAbsent: true }), { code: 'E_INVALID_PATH' });
  const outside = join(fx.root, 'outside');
  await mkdir(outside);
  const link = join(fx.share, 'link');
  await symlink(outside, link, 'dir');
  await assert.rejects(transport.put('link/escaped.md', Buffer.from('secret'), { ifAbsent: true }), { code: 'E_INVALID_PATH' });
});

test('a configured symlink to an external shared folder is accepted as the root', async (t) => {
  const fx = await fixture(t);
  const configuredRoot = join(fx.root, 'shared-link');
  await symlink(fx.share, configuredRoot, 'dir');
  const transport = createFolderTransport({ path: configuredRoot, vaultPath: fx.vault });
  await transport.put('notes/shared.md', Buffer.from('shared\n'), { ifAbsent: true });
  assert.equal(await readFile(join(fx.share, 'notes', 'shared.md'), 'utf8'), 'shared\n');
});

test('folder atomic write failure keeps old bytes and removes ignored temporary files', async (t) => {
  const fx = await fixture(t);
  const target = join(fx.share, 'record.md'); await writeFile(target, 'old complete');
  let temporaryPath;
  const fsOps={...await import('node:fs/promises'), writeFile: async (file,...args) => { temporaryPath=file; return (await import('node:fs/promises')).writeFile(file,...args); }, rename: async () => { throw new Error('injected rename failure'); }};
  const atomicWriter=(file,data,options)=>atomicWriteFile(file,data,{...options,fsOps});
  const transport=createFolderTransport({path:fx.share,vaultPath:fx.vault,atomicWriter});
  const current=await transport.get('record.md');
  await assert.rejects(transport.put('record.md',Buffer.from('new complete'),{ifRev:current.rev}),/injected rename failure/);
  assert.match(temporaryPath,/\/\.brainatlas-tmp-[^/]+$/);
  assert.equal(await readFile(target,'utf8'),'old complete');
  assert.deepEqual(await readdir(fx.share), ['record.md']);
});

test('activation wires selected folder transport and the manifest declares its dependency', async (t) => {
  const fx = await fixture(t);
  const moduleDir = new URL('../../modules/sync-folder/', import.meta.url).pathname;
  const manifest = readModuleManifest(moduleDir);
  assert.deepEqual(manifest.profiles, ['full', 'custom']);
  assert.equal(manifest.experimental, true);
  assert.deepEqual(resolveModuleOrder([
    manifest,
    { name: 'sync-engine', version: '0.1.0-rc.9', description: 'engine', requires: [], provides: ['sync'], profiles: ['full'], entry: 'src/index.mjs' },
  ]).map((item) => item.name), ['sync-engine', 'sync-folder']);
  const ctx = { config: { vault: { path: fx.vault }, sync: { transport: 'folder', options: { path: fx.share } } }, paths: { stateDir: join(fx.root, 'state') }, env: {} };
  await activate(ctx);
  assert.deepEqual(ctx.transport.capabilities, { cas: false, mode: 'object' });
  assert.match(ctx.transport.hostId, /^[a-z0-9-]+$/);
  assert.equal((await ctx.transport.status()).hostId, ctx.transport.hostId);
  assert.deepEqual(await ctx.transport.list(), []);
});
