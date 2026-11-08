import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFolderTransport, isFolderConflictCopy } from '../../../modules/sync-folder/src/index.mjs';

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'folder-accept-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const vault = join(base, 'vault'), share = join(base, 'share'), outside = join(base, 'outside');
  await Promise.all([mkdir(vault), mkdir(share), mkdir(outside)]);
  return { base, vault, share, outside, host: (path = share) => createFolderTransport({ path, vaultPath: vault }) };
}

test('experimental manifest and non-CAS degraded status, including empty share', async t => {
  const f = await fixture(t);
  const manifest = JSON.parse(await readFile(new URL('../../../modules/sync-folder/module.json', import.meta.url)));
  assert.equal(manifest.experimental, true);
  const host = f.host();
  assert.deepEqual(host.capabilities, { cas: false, mode: 'object' });
  assert.deepEqual(await host.status(), { status: 'degraded', code: 'E_DEGRADED', cas: false, conflictCount: 0, conflicts: [] });
});

test('two hosts exchange opaque bytes and reject stale, malformed and missing operations', async t => {
  const f = await fixture(t), a = f.host(), b = f.host();
  const bytes = Uint8Array.from([0, 255, 128]);
  const first = await a.put('notes/a.md', bytes, { ifAbsent: true });
  assert.deepEqual((await b.get('notes/a.md')).bytes, bytes);
  assert.equal(await b.get('missing'), null);
  assert.deepEqual((await b.list('notes/')).map(x => x.path), ['notes/a.md']);
  assert.deepEqual(await b.list('other/'), []);
  await assert.rejects(b.put('notes/a.md', bytes, { ifAbsent: true }), { code: 'E_CONFLICT' });
  await assert.rejects(b.put('notes/a.md', bytes, { ifRev: 'old' }), { code: 'E_CONFLICT' });
  await assert.rejects(b.put('bad', 'not bytes'), TypeError);
  await assert.rejects(b.delete('missing', { ifRev: 'old' }), { code: 'E_NOT_FOUND' });
  await assert.rejects(b.delete('notes/a.md', { ifRev: 'old' }), { code: 'E_CONFLICT' });
  await b.delete('notes/a.md', { ifRev: first.rev });
  assert.equal(await a.get('notes/a.md'), null);
});

test('provider copies are reported independently and placeholders are ignored', async t => {
  const f = await fixture(t), a = f.host(), b = f.host();
  await a.put('page.md', Buffer.from('original'), { ifAbsent: true });
  const copies = ['page 2.md', 'page (conflicted copy host).md', 'page (1).md', 'page-HOST.md', 'page.sync-conflict-20261108-101112-ABC1234.md'];
  for (const name of copies) await writeFile(join(f.share, name), `copy:${name}`);
  for (const name of ['cloud.md.icloud', '~$draft.md', 'draft.tmp', '.syncthing.partial']) await writeFile(join(f.share, name), 'ignored');
  const rows = await b.list();
  assert.deepEqual(rows.filter(r => r.conflict).map(r => r.path).sort(), copies.sort());
  assert.equal(rows.length, copies.length + 1);
  const status = await b.status();
  assert.equal(status.conflictCount, copies.length);
  assert.deepEqual(status.conflicts.sort(), copies.sort());
  assert.equal(Buffer.from((await a.get('page.md')).bytes).toString(), 'original');
  for (const name of copies) assert.equal(Buffer.from((await b.get(name)).bytes).toString(), `copy:${name}`);
  assert.equal(isFolderConflictCopy('ordinary.md'), false);
});

test('ordinary hyphenated names do not create provider conflicts', async t => {
  const f = await fixture(t), host = f.host();
  await host.put('meeting-notes.md', Buffer.from('ordinary'), { ifAbsent: true });
  assert.equal(isFolderConflictCopy('meeting-notes.md'), false);
  assert.equal((await host.status()).conflictCount, 0);
});

test('root must be absolute and outside vault, including resolved symlinks', async t => {
  const f = await fixture(t);
  for (const path of ['relative', f.vault, join(f.vault, 'nested')]) {
    await assert.rejects(f.host(path).list(), { code: 'E_INVALID_PATH' });
  }
  const link = join(f.base, 'vault-link');
  await symlink(f.vault, link, 'dir');
  await assert.rejects(f.host(join(link, 'nested')).list(), { code: 'E_INVALID_PATH' });
  assert.deepEqual(await f.host().list(), []);
});

test('user-directed root symlink outside vault works', async t => {
  const f = await fixture(t), link = join(f.base, 'share-link');
  await symlink(f.share, link, 'dir');
  const host = f.host(link);
  await host.put('note.md', Buffer.from('ok'), { ifAbsent: true });
  assert.equal(await readFile(join(f.share, 'note.md'), 'utf8'), 'ok');
});

test('traversal and child symlinks cannot read, write or delete outside share', async t => {
  const f = await fixture(t), host = f.host();
  await writeFile(join(f.outside, 'target'), 'untouched');
  await symlink(f.outside, join(f.share, 'link'), 'dir');
  await symlink(join(f.outside, 'target'), join(f.share, 'leaf'));
  for (const path of ['../outside/target', 'a/../../outside/target', '/absolute', 'link/target', 'leaf']) {
    await assert.rejects(host.get(path), { code: 'E_INVALID_PATH' });
    await assert.rejects(host.put(path, Buffer.from('overwrite'), { ifAbsent: true }), { code: 'E_INVALID_PATH' });
    await assert.rejects(host.delete(path, { ifRev: 'revision' }), { code: 'E_INVALID_PATH' });
  }
  await assert.rejects(host.list('../'), { code: 'E_INVALID_PATH' });
  assert.deepEqual(await host.list(), []);
  assert.equal(await readFile(join(f.outside, 'target'), 'utf8'), 'untouched');
  assert.deepEqual(await readdir(f.outside), ['target']);
});

test('errors and status do not expose object content or synthetic secret', async t => {
  const f = await fixture(t), host = f.host();
  const secret = ['sk', 'test' + 'x'.repeat(24)].join('-');
  await host.put('private.md', Buffer.from(secret), { ifAbsent: true });
  let error;
  try { await host.put('private.md', Buffer.from(secret), { ifAbsent: true }); } catch (e) { error = e; }
  assert.equal(error?.code, 'E_CONFLICT');
  assert.equal(JSON.stringify({ message: error.message, stack: error.stack, status: await host.status() }).includes(secret), false);
});
