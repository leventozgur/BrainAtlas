// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryTransport, createSyncEngine } from '../../modules/sync-engine/src/index.mjs';
import { createSearcher, searchScope } from '../../packages/core/src/retrieval/index.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'sync-matrix-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const transport = createMemoryTransport();
  const host = async (name) => {
    const vaultPath = join(root, name, 'vault');
    const stateDir = join(root, name, 'state');
    await mkdir(vaultPath, { recursive: true });
    return {
      vaultPath,
      stateDir,
      engine: createSyncEngine({
        vaultPath,
        stateDir,
        config: { sync: { options: {} } },
        transport,
        env: { BRAINATLAS_HOST_ID: name },
        now: () => new Date('2026-11-08T10:11:12.000Z'),
      }),
    };
  };
  return { host, transport };
}

const put = async (host, path, content) => {
  const target = join(host.vaultPath, path);
  await mkdir(join(target, '..'), { recursive: true });
  await writeFile(target, content);
};
const read = (host, path) => readFile(join(host.vaultPath, path), 'utf8').catch(() => null);
const list = (host, dir) => readdir(join(host.vaultPath, dir)).catch(() => []);
const remoteText = async (transport, path) => {
  const object = await transport.get(path);
  return object ? Buffer.from(object.bytes).toString('utf8') : null;
};
async function holdings(host, dir = 'wiki/entities') {
  const texts = [];
  for (const name of await list(host, dir)) texts.push(await read(host, `${dir}/${name}`));
  return texts;
}

test('matrix: edit on one host and delete on the other loses no data', async (t) => {
  const fx = await fixture(t);
  const a = await fx.host('host-a');
  const b = await fx.host('host-b');
  await put(a, 'wiki/entities/page.md', 'base\n');
  await a.engine.run();
  await b.engine.run();
  await put(a, 'wiki/entities/page.md', 'edited on a\n');
  await rm(join(b.vaultPath, 'wiki/entities/page.md'));
  await a.engine.run();
  const result = await b.engine.run();
  assert.notEqual(result.status, 'FAILED');
  const all = [...(await holdings(a)), ...(await holdings(b)), await remoteText(fx.transport, 'wiki/entities/page.md')];
  assert.ok(all.includes('edited on a\n'), 'the edit must survive somewhere');
  await a.engine.run();
  await b.engine.run();
  const merged = [
    ...(await holdings(a)),
    ...(await holdings(b)),
    await remoteText(fx.transport, 'wiki/entities/page.md'),
  ];
  assert.ok(merged.includes('edited on a\n'), 'the edit must survive after both hosts settle');
});

test('matrix: a rename arrives as the new path and the old path waits for approval', async (t) => {
  const fx = await fixture(t);
  const a = await fx.host('host-a');
  const b = await fx.host('host-b');
  await put(a, 'wiki/entities/old-name.md', 'content\n');
  await a.engine.run();
  await b.engine.run();
  await rm(join(a.vaultPath, 'wiki/entities/old-name.md'));
  await put(a, 'wiki/entities/new-name.md', 'content\n');
  const pushed = await a.engine.run();
  assert.equal(pushed.pendingDeletes, 1, 'the old path is a queued delete, never removed silently');
  assert.equal(await remoteText(fx.transport, 'wiki/entities/new-name.md'), 'content\n');
  assert.equal(await remoteText(fx.transport, 'wiki/entities/old-name.md'), 'content\n');
  await b.engine.run();
  assert.equal(await read(b, 'wiki/entities/new-name.md'), 'content\n');
  assert.equal(await read(b, 'wiki/entities/old-name.md'), 'content\n');
});

test('matrix: a host that was offline merges edits to different pages without conflict', async (t) => {
  const fx = await fixture(t);
  const a = await fx.host('host-a');
  const b = await fx.host('host-b');
  await put(a, 'wiki/entities/one.md', 'one\n');
  await put(a, 'wiki/entities/two.md', 'two\n');
  await a.engine.run();
  await b.engine.run();
  await put(b, 'wiki/entities/two.md', 'two edited offline on b\n');
  await put(a, 'wiki/entities/one.md', 'one edited on a\n');
  await a.engine.run();
  await put(a, 'wiki/entities/three.md', 'three from a\n');
  await a.engine.run();
  const back = await b.engine.run();
  assert.notEqual(back.status, 'CONFLICT');
  assert.deepEqual(back.conflicts, []);
  await a.engine.run();
  for (const host of [a, b]) {
    assert.equal(await read(host, 'wiki/entities/one.md'), 'one edited on a\n');
    assert.equal(await read(host, 'wiki/entities/two.md'), 'two edited offline on b\n');
    assert.equal(await read(host, 'wiki/entities/three.md'), 'three from a\n');
  }
  assert.deepEqual(await a.engine.checkPeer(b.stateDir), { status: 'PASS', differences: [] });
});

test('matrix: a host offline through edits to the same page records a conflict and keeps both versions', async (t) => {
  const fx = await fixture(t);
  const a = await fx.host('host-a');
  const b = await fx.host('host-b');
  await put(a, 'wiki/entities/page.md', 'base\n');
  await a.engine.run();
  await b.engine.run();
  await put(b, 'wiki/entities/page.md', 'offline edit on b\n');
  await put(a, 'wiki/entities/page.md', 'edit on a\n');
  await a.engine.run();
  const back = await b.engine.run();
  assert.equal(back.status, 'CONFLICT');
  assert.equal(back.conflicts.length, 1);
  assert.equal((await b.engine.status()).conflictCount, 1);
  const all = await holdings(b);
  assert.ok(all.includes('offline edit on b\n') && all.includes('edit on a\n'));
});

test('matrix: a conflict copy written by sync never appears in search results', async (t) => {
  const fx = await fixture(t);
  const a = await fx.host('host-a');
  const b = await fx.host('host-b');
  await put(a, 'wiki/entities/page.md', 'zephyrite quorum base\n');
  await a.engine.run();
  await b.engine.run();
  await put(a, 'wiki/entities/page.md', 'zephyrite quorum edit from a\n');
  await put(b, 'wiki/entities/page.md', 'zephyrite quorum edit from b\n');
  await a.engine.run();
  await b.engine.run();
  const copies = (await list(b, 'wiki/entities')).filter((name) => name.includes('.conflict-'));
  assert.equal(copies.length, 1);
  const scope = searchScope(b.vaultPath);
  const searcher = createSearcher({
    vaultDir: scope.root,
    stateDir: join(b.stateDir, 'search'),
    exclude: scope.exclude,
  });
  const paths = searcher.search('zephyrite quorum', { limit: 10, abstainThreshold: 0 }).results.map((row) => row.path);
  assert.deepEqual(paths, ['entities/page.md']);
});
