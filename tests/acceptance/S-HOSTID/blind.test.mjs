// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveHostId, createSyncEngine, createMemoryTransport, commands } from '../../../modules/sync-engine/src/index.mjs';
import { createGitTransport, commands as gitCommands } from '../../../modules/sync-git/src/index.mjs';
import { activate as folderActivate } from '../../../modules/sync-folder/src/index.mjs';
import { activate as dropboxActivate } from '../../../modules/sync-dropbox/src/index.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'hostid-blind-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const config = (hostId) => ({ sync: { options: hostId === undefined ? {} : { hostId } } });
const noFile = async (path) => assert.rejects(stat(path), { code: 'ENOENT' });
async function put(vault, path, value) { const target = join(vault, path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, value); }

test('override precedence, empty fallback, normalization, limits and malformed inputs', async (t) => {
  const root = await fixture(t), stateDir = join(root, 'state');
  assert.equal(await resolveHostId({ stateDir, env: { BRAINATLAS_HOST_ID: ' ENV-A ' }, config: config('config-b') }), 'env-a');
  assert.equal(await resolveHostId({ stateDir, env: { BRAINATLAS_HOST_ID: '  ' }, config: config(' Config-B ') }), 'config-b');
  await noFile(join(stateDir, 'sync', 'host-id'));
  assert.equal((await resolveHostId({ stateDir, env: { BRAINATLAS_HOST_ID: 'A'.repeat(100) } })).length, 32);
  await assert.rejects(resolveHostId({ stateDir, env: { BRAINATLAS_HOST_ID: 42 } }), { code: 'E_STATE_INVALID' });
  await assert.rejects(resolveHostId({ stateDir, config: config('!!!') }), { code: 'E_STATE_INVALID' });
  const generated = await resolveHostId({ stateDir, env: {}, config: config('') });
  assert.match(generated, /^[a-z0-9-]{1,32}$/);
  assert.notEqual(generated, 'host');
  assert.equal(await resolveHostId({ stateDir, env: {}, config: config('') }), generated);
});

test('first-use races, mode repair, separate states and a fresh process', async (t) => {
  const root = await fixture(t), stateDir = join(root, 'a'), path = join(stateDir, 'sync', 'host-id');
  const ids = await Promise.all(Array.from({ length: 24 }, () => resolveHostId({ stateDir, env: {} })));
  assert.equal(new Set(ids).size, 1);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(dirname(path)), ['host-id']);
  await chmod(path, 0o644);
  assert.equal(await resolveHostId({ stateDir, env: {} }), ids[0]);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.notEqual(await resolveHostId({ stateDir: join(root, 'b'), env: {} }), ids[0]);
  const moduleUrl = new URL('../../../modules/sync-engine/src/host-id.mjs', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `import { resolveHostId } from ${JSON.stringify(moduleUrl)}; console.log(await resolveHostId({stateDir: process.argv[1], env: {}}));`, stateDir], { encoding: 'utf8', env: { HOME: root, PATH: process.env.PATH } });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), ids[0]);
});

test('invalid stored state and symlink leaf fail closed without leaking values', async (t) => {
  const root = await fixture(t), stateDir = join(root, 'state'), dir = join(stateDir, 'sync'), path = join(dir, 'host-id');
  const secret = ['sk', 'test' + 'x'.repeat(24)].join('-');
  await mkdir(dir, { recursive: true });
  for (const bad of ['', '../escape', 'A', 'a'.repeat(33), secret + '!']) {
    await writeFile(path, bad, { mode: 0o600 });
    await assert.rejects(resolveHostId({ stateDir }), (e) => e.code === 'E_STATE_INVALID' && !String(e.stack).includes(secret));
  }
  await rm(path); const outside = join(root, 'outside'); await writeFile(outside, 'outside', { mode: 0o644 });
  await symlink(outside, path);
  await assert.rejects(resolveHostId({ stateDir }), { code: 'E_STATE_INVALID' });
  assert.equal(await readFile(outside, 'utf8'), 'outside');
  assert.equal((await stat(outside)).mode & 0o777, 0o644);
});

test('symlinked sync directory cannot redirect identity writes outside stateDir', async (t) => {
  const root = await fixture(t), stateDir = join(root, 'state'), outside = join(root, 'outside');
  await mkdir(stateDir); await mkdir(outside); await symlink(outside, join(stateDir, 'sync'));
  let error;
  try { await resolveHostId({ stateDir, env: {} }); } catch (caught) { error = caught; }
  assert.deepEqual(await readdir(outside), [], 'identity must not be written outside stateDir');
  assert.equal(error?.code, 'E_STATE_INVALID');
});

test('transport and status command identities agree without environment override', async (t) => {
  const root = await fixture(t), stateDir = join(root, 'state'), vault = join(root, 'vault');
  await mkdir(vault); const common = { paths: { stateDir }, env: {}, config: { vault: { path: vault }, sync: { transport: 'folder', options: { path: join(root, 'share') } } } };
  await folderActivate(common);
  const engineStatus = JSON.parse(JSON.stringify(await commands.sync(['status', '--json'], common)));
  assert.equal(engineStatus.hostId, common.transport.hostId);
  assert.equal((await common.transport.status()).hostId, engineStatus.hostId);
  const drop = { ...common, transport: undefined, config: { ...common.config, sync: { transport: 'dropbox', options: {} } }, fetch: () => { throw new Error('unexpected network'); }, credentialStore: { get: async () => null, set: async () => {} } };
  await dropboxActivate(drop); assert.equal(drop.transport.hostId, engineStatus.hostId);
  const git = createGitTransport({ stateDir, remote: join(root, 'unused-remote'), env: {} });
  const gitStatus = JSON.parse(JSON.stringify(await gitCommands.status(['--json'], { config: { sync: { transport: 'git' } }, transport: git })));
  assert.equal(gitStatus.hostId, engineStatus.hostId);
  assert.notEqual(gitStatus.hostId, 'host');
});

test('two generated identities label conflict, journal, delete request and peer approval', async (t) => {
  const root = await fixture(t), transport = createMemoryTransport(), logs = [];
  const host = async (name) => { const vault = join(root, name, 'vault'), stateDir = join(root, name, 'state'); await mkdir(vault, { recursive: true }); return { vault, stateDir, engine: createSyncEngine({ vaultPath: vault, stateDir, transport, config: config(), env: {}, now: () => new Date('2026-01-02T03:04:05Z'), logger: { info: (...v) => logs.push(v) } }) }; };
  const a = await host('a'), b = await host('b');
  const idA = (await a.engine.status()).hostId, idB = (await b.engine.status()).hostId;
  assert.notEqual(idA, idB);
  const path = 'wiki/entities/item.md', deletion = 'wiki/entities/delete.md';
  await put(a.vault, path, 'base\n'); await put(a.vault, deletion, 'delete me\n');
  await a.engine.run(); await b.engine.run();
  await put(a.vault, path, 'from a\n'); await put(b.vault, path, 'from b\n');
  await a.engine.run(); const conflict = await b.engine.run();
  assert.ok(conflict.conflicts.some((x) => x.conflictCopy?.includes(`.conflict-${idB}-`)));
  assert.equal(JSON.parse(await readFile(b.engine.journalPath, 'utf8')).hostId, idB);
  await rm(join(a.vault, deletion)); await a.engine.run();
  assert.ok(await transport.get(deletion));
  const request = (await transport.list('.brainatlas-sync/meta/')).find((x) => x.path.includes('pending-deletions'));
  assert.ok(request); assert.equal(JSON.parse(Buffer.from((await transport.get(request.path)).bytes)).requestedBy, idA);
  await b.engine.run(); assert.equal(await readFile(join(b.vault, deletion), 'utf8'), 'delete me\n');
  await assert.rejects(b.engine.approveDeletes(['../outside']), { code: 'E_INVALID_PATH' });
  assert.deepEqual(await b.engine.approveDeletes([deletion]), { approved: [deletion] });
  const tombstone = (await transport.list('.brainatlas-sync/meta/tombstones/'))[0];
  assert.equal(JSON.parse(Buffer.from((await transport.get(tombstone.path)).bytes)).approvedBy, idB);
  assert.equal(await transport.get(deletion), null);
  await noFile(join(b.vault, deletion));
  const secret = ['sk', 'test' + 'x'.repeat(24)].join('-');
  await put(a.vault, 'wiki/entities/secret.md', `api_key: "${secret}"\n`);
  const result = await a.engine.run();
  assert.ok(!JSON.stringify({ logs, result, status: await a.engine.status() }).includes(secret));
  assert.equal(await transport.get('wiki/entities/secret.md'), null);
});
