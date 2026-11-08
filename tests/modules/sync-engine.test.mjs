// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryTransport, createSyncEngine, mergeIndexThreeWay, mergeLogThreeWay, planScheduler, planSchedulerUninstall, activate, commands } from '../../modules/sync-engine/src/index.mjs';
import { createFolderTransport } from '../../modules/sync-folder/src/index.mjs';

async function fixture(t, { config = { sync: { options: {} } }, transport = createMemoryTransport(), initial = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'sync-engine-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const host = async (name) => {
    const vaultPath = join(root, name, 'vault');
    const stateDir = join(root, name, 'state');
    await mkdir(vaultPath, { recursive: true });
    for (const [path, content] of Object.entries(initial)) {
      const target = join(vaultPath, path);
      await mkdir(join(target, '..'), { recursive: true });
      await writeFile(target, content);
    }
    return { vaultPath, stateDir, engine: createSyncEngine({ vaultPath, stateDir, config, transport, hostId: name, now: () => new Date('2026-11-08T10:11:12.000Z') }) };
  };
  return { root, host, transport };
}

async function put(host, path, content) {
  const target = join(host.vaultPath, path);
  await mkdir(join(target, '..'), { recursive: true });
  await writeFile(target, content);
}

test('memory transport enforces relative paths, defensive bytes and compare-and-swap revisions', async () => {
  const transport = createMemoryTransport();
  const first = await transport.put('wiki/page.md', Buffer.from('one'), { ifAbsent: true });
  const read = await transport.get('wiki/page.md');
  read.bytes[0] = 0;
  assert.equal(Buffer.from((await transport.get('wiki/page.md')).bytes).toString(), 'one');
  await assert.rejects(transport.put('wiki/page.md', Buffer.from('stale'), { ifRev: 'wrong' }), { code: 'E_CONFLICT' });
  await assert.rejects(transport.put('../escape.md', Buffer.from('x'), { ifAbsent: true }), { code: 'E_INVALID_PATH' });
  await transport.delete('wiki/page.md', { ifRev: first.rev });
  assert.equal(await transport.get('wiki/page.md'), null);
});

test('two fake hosts create, pull, modify and compare manifest v3 without content differences', async (t) => {
  const fx = await fixture(t);
  const a = await fx.host('host-a'), b = await fx.host('host-b');
  await put(a, 'wiki/entities/alpha.md', '# Alpha\nfirst version\n');
  const created = await a.engine.run();
  assert.equal(created.status, 'SYNCED');
  assert.equal(created.pushed, 1);
  const manifest = await a.engine.buildManifest();
  assert.equal(manifest.version, 3);
  assert.deepEqual(Object.keys(manifest.files[0]).sort(), ['mtime', 'path', 'rev', 'sha256', 'size']);
  assert.equal(manifest.files[0].rev !== null, true);

  assert.equal((await b.engine.run()).pulled, 1);
  assert.equal(await readFile(join(b.vaultPath, 'wiki/entities/alpha.md'), 'utf8'), '# Alpha\nfirst version\n');
  assert.deepEqual(await a.engine.checkPeer(b.stateDir), { status: 'PASS', differences: [] });

  await put(a, 'wiki/entities/alpha.md', '# Alpha\nsecond version\n');
  assert.equal((await a.engine.run()).pushed, 1);
  assert.equal((await b.engine.run()).pulled, 1);
  assert.equal(await readFile(join(b.vaultPath, 'wiki/entities/alpha.md'), 'utf8'), '# Alpha\nsecond version\n');
  assert.deepEqual(await a.engine.checkPeer(b.stateDir), { status: 'PASS', differences: [] });
});

test('concurrent edits retain local canonical data and write a host tagged conflict copy', async (t) => {
  const fx = await fixture(t);
  const a = await fx.host('host-a'), b = await fx.host('host-b');
  await put(a, 'wiki/entities/page.md', 'base\n');
  await a.engine.run(); await b.engine.run();
  await put(a, 'wiki/entities/page.md', 'edit from a\n');
  await put(b, 'wiki/entities/page.md', 'edit from b\n');
  await a.engine.run();
  const result = await b.engine.run();
  assert.equal(result.status, 'CONFLICT');
  assert.equal(await readFile(join(b.vaultPath, 'wiki/entities/page.md'), 'utf8'), 'edit from b\n');
  const files = await readdir(join(b.vaultPath, 'wiki/entities'));
  const copy = files.find((name) => name.includes('.conflict-host-b-'));
  assert.ok(copy);
  assert.equal(await readFile(join(b.vaultPath, 'wiki/entities', copy), 'utf8'), 'edit from a\n');
  assert.ok(result.conflicts.some((row) => row.path === 'wiki/entities/page.md' && row.kind === 'edit-conflict'));
  const journal = JSON.parse(await readFile(b.engine.journalPath, 'utf8'));
  assert.ok(journal.operations.some((row) => row.action === 'conflict-edit-conflict' && row.state === 'conflict'));
});

test('local deletes stay queued until approval and approved tombstones reach the peer', async (t) => {
  const fx = await fixture(t);
  const a = await fx.host('host-a'), b = await fx.host('host-b');
  await put(a, 'wiki/entities/remove.md', 'shared\n');
  await a.engine.run(); await b.engine.run();
  await rm(join(a.vaultPath, 'wiki/entities/remove.md'));
  const queued = await a.engine.run();
  assert.equal(queued.status, 'PENDING');
  assert.equal(queued.pendingDeletes, 1);
  assert.ok(await fx.transport.get('wiki/entities/remove.md'));
  const context = { config: { vault: { path: a.vaultPath }, sync: { options: {} } }, paths: { stateDir: a.stateDir }, transport: fx.transport, hostId: 'host-a' };
  assert.deepEqual(await commands.approve(context, { paths: ['wiki/entities/remove.md'] }), { approved: ['wiki/entities/remove.md'] });
  assert.equal(await fx.transport.get('wiki/entities/remove.md'), null);
  await b.engine.run();
  await assert.rejects(readFile(join(b.vaultPath, 'wiki/entities/remove.md')), { code: 'ENOENT' });
  assert.deepEqual(await a.engine.checkPeer(b.stateDir), { status: 'PASS', differences: [] });
});

test('remote delete requests appear on the peer and peer approval removes both copies', async (t) => {
  const fx = await fixture(t);
  const a = await fx.host('host-a'), b = await fx.host('host-b');
  const path = 'wiki/entities/peer-remove.md';
  await put(a, path, 'shared\n');
  await a.engine.run(); await b.engine.run();
  await rm(join(a.vaultPath, path));

  const requested = await a.engine.run();
  assert.equal(requested.status, 'PENDING');
  assert.equal(requested.pendingDeletes, 1);
  assert.equal((await a.engine.status()).pendingDeleteCount, 1);
  assert.deepEqual((await a.engine.status()).pendingDeletionPaths, [path]);
  assert.ok(await fx.transport.get(path), 'delete request must leave the shared object intact');

  await b.engine.run();
  assert.equal((await b.engine.status()).pendingDeleteCount, 1);
  assert.deepEqual((await b.engine.status()).pendingDeletionPaths, [path]);
  assert.equal(await readFile(join(b.vaultPath, path), 'utf8'), 'shared\n');
  const context = { config: { vault: { path: b.vaultPath }, sync: { options: {} } }, paths: { stateDir: b.stateDir }, transport: fx.transport, hostId: 'host-b' };
  assert.deepEqual(await commands.approve(context, ['--all']), { approved: [path] });

  assert.equal(await fx.transport.get(path), null);
  await assert.rejects(readFile(join(b.vaultPath, path)), { code: 'ENOENT' });
  await a.engine.run();
  assert.equal((await a.engine.status()).pendingDeleteCount, 0);
  assert.deepEqual(await a.engine.checkPeer(b.stateDir), { status: 'PASS', differences: [] });
});

test('secret path and content refusals expose only path and ruleId and do not upload', async (t) => {
  const logs = [];
  const root = await mkdtemp(join(tmpdir(), 'sync-engine-secret-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vaultPath = join(root, 'vault'), stateDir = join(root, 'state');
  await mkdir(join(vaultPath, 'wiki/entities'), { recursive: true });
  await writeFile(join(vaultPath, 'wiki/entities/leak.md'), 'api_key: "Z9kLm2Pq8R4tWx7V3cN"\n');
  await writeFile(join(vaultPath, '.env'), 'NOT_A_REAL_VALUE=placeholder\n');
  await writeFile(join(vaultPath, 'wiki/entities/local.md'), '---\nsync: local\n---\nprivate\n');
  const transport = createMemoryTransport();
  const engine = createSyncEngine({ vaultPath, stateDir, config: { sync: { options: { include: ['**/*'] } } }, transport, logger: { info: (...args) => logs.push(args) } });
  const result = await engine.run();
  assert.equal(result.status, 'PENDING');
  assert.deepEqual(result.refused.sort((a, b) => a.path.localeCompare(b.path)), [
    { path: '.env', ruleId: 'denied-path' }, { path: 'wiki/entities/leak.md', ruleId: 'high-entropy-assignment' },
  ]);
  assert.equal(await transport.get('.env'), null);
  assert.equal(await transport.get('wiki/entities/leak.md'), null);
  assert.equal(await transport.get('wiki/entities/local.md'), null);
  assert.equal(JSON.stringify({ result, logs }).includes('Z9kLm2Pq8R4tWx7V3cN'), false);
  assert.ok(result.refused.every((row) => Object.keys(row).sort().join(',') === 'path,ruleId'));
});

test('index entries and append-only log entries merge independently from a shared base', async (t) => {
  const fx = await fixture(t);
  const a = await fx.host('host-a'), b = await fx.host('host-b');
  await put(a, 'wiki/index.md', '# Wiki index\n\n## Notes\n\n- [Base](wiki/entities/base.md) — base\n');
  await put(a, 'wiki/log.md', '# Wiki log\n\n<!-- Append-only change history. -->\n');
  await a.engine.run(); await b.engine.run();
  await put(a, 'wiki/index.md', '# Wiki index\n\n## Notes\n\n- [Base](wiki/entities/base.md) — base\n- [From A](wiki/entities/a.md) — added #a\n');
  await put(a, 'wiki/log.md', '# Wiki log\n\n<!-- Append-only change history. -->\n\n- [2026-11-08T10:00:00Z] change from a\n');
  await put(b, 'wiki/index.md', '# Wiki index\n\n## Notes\n\n- [Base](wiki/entities/base.md) — base\n- [From B](wiki/entities/b.md) — added #b\n');
  await put(b, 'wiki/log.md', '# Wiki log\n\n<!-- Append-only change history. -->\n\n- [2026-11-08T10:01:00Z] change from b\n');
  await a.engine.run();
  const result = await b.engine.run();
  assert.equal(result.status, 'SYNCED');
  assert.equal(result.merged, 2);
  const index = await readFile(join(b.vaultPath, 'wiki/index.md'), 'utf8');
  assert.match(index, /From A/); assert.match(index, /From B/);
  const log = await readFile(join(b.vaultPath, 'wiki/log.md'), 'utf8');
  assert.match(log, /change from a/); assert.match(log, /change from b/);
  assert.equal(mergeIndexThreeWay('# I\n', '# I\n\n## A\n\n- [x](x.md)\n', '# I\n\n## A\n\n- [y](y.md)\n').conflicts.length, 0);
  assert.equal(mergeLogThreeWay('# L\n', '# L\n\n- [a] one\n', '# L\n\n- [b] two\n').conflicts.length, 0);

  const indexBase = '# Wiki Index\n\n## Notes\n\n- [Base](wiki/base.md) — original\n';
  const indexChanged = '# Wiki Index\n\n## Notes\n\n- [Base](wiki/base.md) — updated\n';
  const indexMerge = mergeIndexThreeWay(indexBase, indexChanged, indexBase);
  assert.deepEqual(indexMerge.conflicts, []);
  assert.match(indexMerge.content, /updated/);
  assert.doesNotMatch(indexMerge.content, /original/);

  const logBase = '# Wiki Log\n\n## Shared entry\noriginal\n';
  const logChanged = '# Wiki Log\n\n## Shared entry\nupdated\n';
  const logMerge = mergeLogThreeWay(logBase, logChanged, logBase);
  assert.deepEqual(logMerge.conflicts, []);
  assert.match(logMerge.content, /updated/);
  assert.doesNotMatch(logMerge.content, /original/);
  assert.equal(mergeLogThreeWay(logBase, logChanged, logChanged).content, logMerge.content);
});

test('interrupted put is journaled and resumes idempotently', async (t) => {
  const transport = createMemoryTransport({ failures: [{ type: 'interruption', operation: 'put', after: 1 }] });
  const fx = await fixture(t, { transport });
  const a = await fx.host('host-a');
  await put(a, 'wiki/entities/a.md', 'a\n'); await put(a, 'wiki/entities/b.md', 'b\n');
  await assert.rejects(a.engine.run(), { code: 'E_INTERRUPTED' });
  const journal = JSON.parse(await readFile(a.engine.journalPath, 'utf8'));
  assert.equal(journal.phase, 'interrupted');
  assert.ok(journal.operations.some((row) => row.state === 'done'));
  assert.ok(journal.operations.some((row) => row.state === 'running'));
  const resumed = await a.engine.run();
  assert.equal(resumed.status, 'SYNCED');
  assert.ok(await transport.get('wiki/entities/a.md'));
  assert.ok(await transport.get('wiki/entities/b.md'));
  assert.equal((await a.engine.status()).fileCount, 2);
});

test('scope globs, peer check, scheduler plans and module commands expose the specified surface', async (t) => {
  const fx = await fixture(t);
  const a = await fx.host('host-a'), b = await fx.host('host-b');
  await put(a, 'wiki/a.md', 'A\n'); await a.engine.run(); await b.engine.run();
  await put(b, 'wiki/a.md', 'drift\n'); await b.engine.run();
  const drift = await a.engine.checkPeer(b.stateDir);
  assert.equal(drift.status, 'DRIFT');
  assert.deepEqual(drift.differences, [{ path: 'wiki/a.md', kind: 'modified' }]);
  const context = { config: { vault: { path: a.vaultPath }, sync: { options: {} } }, paths: { stateDir: a.stateDir }, transport: fx.transport, hostId: 'host-a' };
  assert.deepEqual(await commands.check(context, { peer: b.stateDir }), drift);
  assert.deepEqual(await commands.sync(['check', '--peer', b.stateDir, '--json'], context), drift);
  assert.deepEqual(await commands.pause(context), { status: 'PAUSED' });
  assert.equal((await commands.status(context)).status, 'PAUSED');
  assert.equal((await commands.run(context)).status, 'PAUSED');
  assert.deepEqual(await commands.resume(context), { status: 'RESUMED' });
  assert.equal((await commands.run(context)).status, 'SYNCED');
  assert.equal((await commands.status(context)).status, 'SYNCED');

  const mac = planScheduler({ platform: 'darwin', paths: { binPath: '/Users/you/bin/brainatlas', stateDir: '/Users/you/state' }, intervalMin: 15 });
  assert.match(mac.text, /<key>StartInterval<\/key><integer>900<\/integer>/);
  assert.deepEqual(mac.uninstall, ['/Users/you/state/scheduler/com.brainatlas.sync.plist']);
  const linux = planScheduler({ platform: 'linux', paths: { binPath: '/Users/you/bin/brainatlas', stateDir: '/Users/you/state' }, intervalMin: 20 });
  assert.match(linux.text, /OnUnitActiveSec=20min/);
  assert.equal(linux.files.length, 2);
  assert.equal(planSchedulerUninstall({ platform: 'linux', paths: { binPath: '/Users/you/bin/brainatlas', stateDir: '/Users/you/state' } }).files.length, 2);
  assert.deepEqual(Object.keys(commands).sort(), ['approve', 'check', 'pause', 'resume', 'run', 'status', 'sync']);
  assert.equal(await activate({ config: {}, paths: {} }), undefined);
});

test('sync status reports folder transport degradation and its reason', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'sync-folder-status-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vaultPath = join(root, 'vault'); const sharedPath = join(root, 'shared'); const stateDir = join(root, 'state');
  await Promise.all([mkdir(vaultPath), mkdir(sharedPath)]);
  const transport = createFolderTransport({ path: sharedPath, vaultPath });
  const engine = createSyncEngine({ vaultPath, stateDir, transport, config: { sync: { options: {} } } });
  const context = { config: { vault: { path: vaultPath }, sync: { options: {} } }, paths: { stateDir }, transport };
  const status = await commands.status(context);
  assert.equal(status.status, 'DEGRADED');
  assert.equal(status.transport.status, 'degraded');
  assert.match(status.degradedReason, /cannot guarantee compare-and-swap/);
  assert.equal((await engine.status()).status, 'DEGRADED');
});
