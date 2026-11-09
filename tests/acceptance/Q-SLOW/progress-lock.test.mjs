// SPDX-License-Identifier: MIT
// Acceptance (6, index-store part) onProgress objects / ETA, and (8) lock behaviour.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { updateSemanticIndex, buildSemanticIndex, markdownChunks } from '../../../modules/semantic/src/index.mjs';
import { exists, fakeClock, fakeProvider, readJson, sectionPage, workspace } from './helpers.mjs';

const KEYS = ['batchSize', 'done', 'elapsedMs', 'etaMs', 'phase', 'total'];

async function collect(t, { files, chunks = 100, durations = [1000], provider, partialFirst = false } = {}) {
  const w = await workspace(t, files ?? { 'page.md': sectionPage('Page', chunks) });
  const clock = fakeClock();
  const p = provider ?? fakeProvider({ clock, durations });
  const events = [];
  const options = { corpusDir: w.wiki, stateDir: w.stateDir, provider: p, chunkMarkdown: markdownChunks, now: p.clock.now, onProgress: event => { events.push(structuredClone(event)); } };
  await updateSemanticIndex(options);
  return { w, p, events };
}

test('onProgress receives objects with exactly the documented keys', async t => {
  const { events } = await collect(t);
  assert.ok(events.length > 3);
  for (const event of events) {
    assert.equal(typeof event, 'object');
    assert.deepEqual(Object.keys(event).sort(), KEYS);
    assert.ok(['scan', 'embed'].includes(event.phase));
    assert.ok(Number.isInteger(event.done) && event.done >= 0 && event.done <= event.total);
    assert.ok(Number.isFinite(event.elapsedMs) && event.elapsedMs >= 0);
    assert.ok(event.etaMs === null || (Number.isFinite(event.etaMs) && event.etaMs >= 0));
    assert.ok(Number.isInteger(event.batchSize) && event.batchSize >= 0);
  }
});

test('scan phase counts files; embed phase counts chunks; phases are ordered', async t => {
  const files = { 'a.md': sectionPage('A', 3), 'b.md': sectionPage('B', 4), 'c.md': sectionPage('C', 5) };
  const { events } = await collect(t, { files });
  const scan = events.filter(event => event.phase === 'scan');
  const embed = events.filter(event => event.phase === 'embed');
  assert.equal(scan.at(-1).total, 3);
  assert.equal(scan.at(-1).done, 3);
  assert.ok(scan.every(event => event.total === 3));
  assert.equal(scan.every(event => event.etaMs === null), true);
  assert.equal(events.findIndex(event => event.phase === 'embed') > events.map(event => event.phase).lastIndexOf('scan'), true, 'scan events come before embed events');
  assert.ok(embed.every(event => event.total === 12), 'embed total is the number of chunks to embed');
  assert.equal(embed.at(-1).done, 12);
  assert.deepEqual(embed.map(event => event.done), [...embed.map(event => event.done)].sort((a, b) => a - b), 'done is monotonic');
});

test('etaMs is null before the first group completes and a finite number afterwards; first estimate uses the observed rate', async t => {
  const { events, p } = await collect(t, { chunks: 100, durations: [10000, 8000] });
  const embed = events.filter(event => event.phase === 'embed');
  assert.equal(embed[0].etaMs, null, 'before first group');
  assert.equal(embed[0].done, 0);
  assert.equal(embed[0].batchSize, 32);
  assert.equal(typeof embed[1].etaMs, 'number');
  assert.equal(embed[1].done, 32);
  // 32 chunks in 10 s with 68 left: 10000 / 32 * 68 = 21250
  assert.ok(Math.abs(embed[1].etaMs - 21250) < 1, `eta ${embed[1].etaMs}`);
  assert.ok(embed.slice(1).every(event => typeof event.etaMs === 'number' && event.etaMs >= 0));
  assert.equal(embed.at(-1).etaMs, 0, 'nothing remaining at the end');
  assert.equal(p.sizes[0], 32);
  for (let k = 0; k < p.sizes.length - 1; k++) assert.equal(embed[k].batchSize, p.sizes[k], `event ${k} reports the size of the upcoming group`);
});

test('cached chunks are added to done at the start of the embed phase and ETA only reflects work remaining', async t => {
  const w = await workspace(t, { 'page.md': sectionPage('Page', 100) });
  await assert.rejects(updateSemanticIndex({ corpusDir: w.wiki, stateDir: w.stateDir, provider: fakeProvider({ failOnCall: 3 }), chunkMarkdown: markdownChunks }));
  const events = [];
  const provider = fakeProvider({ durations: [10000] });
  await updateSemanticIndex({ corpusDir: w.wiki, stateDir: w.stateDir, provider, chunkMarkdown: markdownChunks, now: provider.clock.now, onProgress: event => events.push({ ...event }) });
  const embed = events.filter(event => event.phase === 'embed');
  assert.equal(embed[0].done, 64);
  assert.equal(embed[0].total, 100);
  assert.equal(embed[0].etaMs, null);
  assert.equal(provider.texts.length, 36);
  assert.equal(embed[1].done, 96);
  assert.ok(Math.abs(embed[1].etaMs - 10000 / 32 * 4) < 1, `eta ${embed[1].etaMs}`);
  assert.equal(embed.at(-1).done, 100);
});

test('an onProgress that throws aborts indexing, keeps completed work in the partial file and releases the lock', async t => {
  const w = await workspace(t, { 'page.md': sectionPage('Page', 100) });
  const provider = fakeProvider({ durations: [100] });
  let seen = 0;
  await assert.rejects(updateSemanticIndex({ corpusDir: w.wiki, stateDir: w.stateDir, provider, chunkMarkdown: markdownChunks, now: provider.clock.now, onProgress: event => { if (event.phase === 'embed' && event.done >= 32 && ++seen) throw Object.assign(new Error('stop'), { code: 'E_STOP' }); } }), { code: 'E_STOP' });
  const partial = await readJson(join(w.semanticDir, 'index.partial.json'));
  assert.equal(Object.keys(partial.vectors).length, 32);
  assert.equal(await exists(join(w.semanticDir, 'index.lock')), false);
  assert.equal(await exists(join(w.semanticDir, 'index.json')), false);
});

// ---------- lock (8) ----------
async function lockFixture(t, count = 10) {
  const w = await workspace(t, { 'page.md': sectionPage('Page', count) });
  w.lock = join(w.semanticDir, 'index.lock');
  w.run = (provider, extra = {}) => updateSemanticIndex({ corpusDir: w.wiki, stateDir: w.stateDir, provider, chunkMarkdown: markdownChunks, now: provider.clock.now, ...extra });
  w.writeLock = async value => { await mkdir(w.semanticDir, { recursive: true }); await writeFile(w.lock, typeof value === 'string' ? value : JSON.stringify(value)); };
  return w;
}
function deadPid() {
  const child = spawnSync(process.execPath, ['-e', '0']);
  assert.equal(child.status, 0);
  return child.pid;
}

test('a live pid holding a fresh lock yields E_SEMANTIC_BUSY, with no embedding and the foreign lock left in place', async t => {
  const w = await lockFixture(t);
  const provider = fakeProvider({});
  const held = { pid: process.pid, startedAt: provider.clock.now() - 1000 };
  await w.writeLock(held);
  await assert.rejects(w.run(provider), error => { assert.equal(error.code, 'E_SEMANTIC_BUSY'); assert.doesNotMatch(error.message, /\/|pid|\d{4,}/u, 'no path or pid leak'); return true; });
  assert.equal(provider.calls.length, 0);
  assert.deepEqual(await readJson(w.lock), held, 'busy attempt must not delete or rewrite the other lock');
  assert.equal(await exists(join(w.semanticDir, 'index.json')), false);
});

test('a live parent process pid (a real other process) also blocks', async t => {
  const w = await lockFixture(t);
  const provider = fakeProvider({});
  await w.writeLock({ pid: process.ppid, startedAt: provider.clock.now() });
  await assert.rejects(w.run(provider), { code: 'E_SEMANTIC_BUSY' });
});

test('a dead pid lock is taken over, indexing completes and the lock is removed', async t => {
  const w = await lockFixture(t);
  const provider = fakeProvider({});
  await w.writeLock({ pid: deadPid(), startedAt: provider.clock.now() });
  const index = await w.run(provider);
  assert.equal(index.entries.length, 10);
  assert.equal(await exists(w.lock), false);
});

test('a lock older than 6 hours is taken over even if the pid is alive; just under 6 hours is still busy', async t => {
  const SIX_HOURS = 6 * 60 * 60 * 1000;
  const old = await lockFixture(t);
  const provider = fakeProvider({});
  await old.writeLock({ pid: process.pid, startedAt: provider.clock.now() - SIX_HOURS - 1 });
  assert.equal((await old.run(provider)).entries.length, 10);
  assert.equal(await exists(old.lock), false);

  const fresh = await lockFixture(t);
  const second = fakeProvider({});
  await fresh.writeLock({ pid: process.pid, startedAt: second.clock.now() - SIX_HOURS + 60000 });
  await assert.rejects(fresh.run(second), { code: 'E_SEMANTIC_BUSY' });
  assert.equal(second.calls.length, 0);
});

test('garbage, empty and malformed locks are taken over rather than wedging indexing', async t => {
  for (const body of ['', 'not json', '{}', '{"pid":"x"}', '{"pid":-4,"startedAt":1}', '[]', 'null']) {
    const w = await lockFixture(t);
    const provider = fakeProvider({});
    await w.writeLock(body);
    const index = await w.run(provider);
    assert.equal(index.entries.length, 10, body);
    assert.equal(await exists(w.lock), false);
  }
});

test('the lock is created with {pid, startedAt}, mode 0600, while indexing and removed on success', async t => {
  const w = await lockFixture(t);
  let observed;
  const provider = fakeProvider({ onCall: async () => { observed = { body: await readJson(w.lock), mode: (await stat(w.lock)).mode & 0o777 }; } });
  await w.run(provider);
  assert.deepEqual(Object.keys(observed.body).sort(), ['pid', 'startedAt']);
  assert.equal(observed.body.pid, process.pid);
  assert.equal(observed.body.startedAt, 1_700_000_000_000, 'startedAt comes from the injected clock');
  assert.equal(observed.mode, 0o600);
  assert.equal(await exists(w.lock), false);
});

test('the lock is removed in finally when indexing fails', async t => {
  const w = await lockFixture(t, 100);
  await assert.rejects(w.run(fakeProvider({ failOnCall: 2 })), /fixture provider failure/u);
  assert.equal(await exists(w.lock), false);
  const controller = new AbortController();
  await assert.rejects(w.run(fakeProvider({ onCall: () => controller.abort() }), { signal: controller.signal }), { code: 'E_SEMANTIC_ABORTED' });
  assert.equal(await exists(w.lock), false);
  await assert.rejects(w.run(fakeProvider({}), { corpusDir: join(w.root, 'missing-wiki') }));
  assert.equal(await exists(w.lock), false, 'lock released even when scanning fails');
});

test('a forced rebuild started while an update holds the lock is refused with E_SEMANTIC_BUSY; the update finishes', async t => {
  const w = await lockFixture(t, 40);
  let release; const gate = new Promise(resolve => { release = resolve; });
  let entered; const started = new Promise(resolve => { entered = resolve; });
  const slow = fakeProvider({ onCall: async index => { if (index === 1) { entered(); await gate; } } });
  const running = w.run(slow);
  await started;
  const other = fakeProvider({});
  await assert.rejects(buildSemanticIndex({ corpusDir: w.wiki, stateDir: w.stateDir, provider: other, chunkMarkdown: markdownChunks, now: other.clock.now }), { code: 'E_SEMANTIC_BUSY' });
  assert.equal(other.calls.length, 0);
  assert.equal(await exists(w.lock), true, 'refused caller did not steal or remove the running lock');
  release();
  const index = await running;
  assert.equal(index.entries.length, 40);
  assert.equal(await exists(w.lock), false);
});

test('in-process callers on the same state directory share one run', async t => {
  const w = await lockFixture(t, 40);
  const provider = fakeProvider({});
  const [a, b] = await Promise.all([w.run(provider), w.run(provider)]);
  assert.equal(a, b);
  assert.equal(provider.texts.length, 40, 'each chunk embedded once');
});

test('the lock file is created only under the state directory (no write into the vault)', async t => {
  const w = await lockFixture(t);
  const before = await readFile(join(w.wiki, 'page.md'), 'utf8');
  await w.run(fakeProvider({}));
  assert.equal(await readFile(join(w.wiki, 'page.md'), 'utf8'), before);
  assert.equal(await exists(join(w.wiki, 'index.lock')), false);
  assert.equal(await exists(join(w.vault, 'semantic')), false);
});
