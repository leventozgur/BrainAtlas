// SPDX-License-Identifier: MIT
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateSemanticIndex, buildSemanticIndex, readSemanticIndex, countPendingChunks } from '../../../modules/semantic/src/index-store.mjs';
import { defaultConfig, validateConfig } from '../../../packages/core/src/config/index.mjs';

async function fixture(t, count = 8) {
  const root = await mkdtemp(join(tmpdir(), 'semantic-slow-')); t.after(() => rm(root, { recursive: true, force: true }));
  const corpusDir = join(root, 'wiki'), stateDir = join(root, 'state'); await mkdir(corpusDir);
  for (let i = 0; i < count; i++) await writeFile(join(corpusDir, `${i}.md`), `text ${i}`);
  return { corpusDir, stateDir, chunkMarkdown: (text, path) => [{ path, text }], provider: { id: 'fake', fingerprint: 'fp', dims: 1, embedDocuments: async texts => texts.map(text => [Number(text.slice(5))]) } };
}
const partialPath = f => join(f.stateDir, 'semantic', 'index.partial.json');
test('adaptive batches and progress use injected clock', async t => {
  const f = await fixture(t, 20); let time = 0; const sizes = [], events = [];
  f.provider.embedDocuments = async texts => { sizes.push(texts.length); time += sizes.length === 1 ? 25000 : 3000; return texts.map(text => [Number(text.slice(5))]); };
  await updateSemanticIndex({ ...f, indexBatchSize: 4, now: () => time, onProgress: p => events.push(p) });
  assert.deepEqual(sizes.slice(0, 3), [4, 2, 4]);
  const embeds = events.filter(p => p.phase === 'embed'); assert.equal(embeds[0].etaMs, null); assert.equal(typeof embeds[1].etaMs, 'number');
});
test('failed batches checkpoint and resume identical to a clean build', async t => {
  const f = await fixture(t); let calls = 0;
  const original = f.provider.embedDocuments;
  f.provider.embedDocuments = async texts => { if (++calls === 2) throw new Error('failure'); return original(texts); };
  await assert.rejects(updateSemanticIndex({ ...f, indexBatchSize: 2 }));
  const partial = JSON.parse(await readFile(partialPath(f), 'utf8')); assert.equal(Object.keys(partial.vectors).length, 2);
  assert.equal((await stat(partialPath(f))).mode & 0o777, 0o600); assert.equal(await readSemanticIndex(f.stateDir), null);
  assert.equal(await countPendingChunks(f), 6);
  let resumed = 0; f.provider.embedDocuments = async texts => { resumed += texts.length; return original(texts); };
  const result = await updateSemanticIndex({ ...f, indexBatchSize: 2 }); assert.equal(resumed, 6);
  await assert.rejects(readFile(partialPath(f)), { code: 'ENOENT' });
  const clean = await buildSemanticIndex(f); delete result.createdAt; delete clean.createdAt; assert.deepEqual(result, clean);
});
test('incompatible checkpoints and forced builds never reuse vectors', async t => {
  const f = await fixture(t, 4); let calls = 0; const original = f.provider.embedDocuments;
  f.provider.embedDocuments = async texts => { if (++calls === 2) throw new Error('failure'); return original(texts); };
  await assert.rejects(updateSemanticIndex({ ...f, indexBatchSize: 2 }));
  let partial = JSON.parse(await readFile(partialPath(f), 'utf8')); partial.providerFingerprint = 'other'; await writeFile(partialPath(f), JSON.stringify(partial));
  let embedded = 0; f.provider.embedDocuments = async texts => { embedded += texts.length; return original(texts); };
  await updateSemanticIndex(f); assert.equal(embedded, 4);
  await writeFile(partialPath(f), JSON.stringify(partial)); embedded = 0; await buildSemanticIndex(f); assert.equal(embedded, 4); await assert.rejects(readFile(partialPath(f)));
});
test('live lock reports busy and dead lock is recovered', async t => {
  const f = await fixture(t); const dir = join(f.stateDir, 'semantic'); await mkdir(dir, { recursive: true }); const lock = join(dir, 'index.lock');
  await writeFile(lock, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
  await assert.rejects(updateSemanticIndex(f), { code: 'E_SEMANTIC_BUSY' });
  await writeFile(lock, JSON.stringify({ pid: 2147483647, startedAt: Date.now() })); await updateSemanticIndex(f); await assert.rejects(readFile(lock), { code: 'ENOENT' });
});
test('new config settings validate their integer limits', () => {
  for (const [key, value] of [['indexTimeoutMs', 0], ['indexTimeoutMs', 1.5], ['indexBatchSize', 0], ['indexBatchSize', 65], ['indexBatchSize', '2']]) { const c = defaultConfig('custom'); c.semantic[key] = value; assert.equal(validateConfig(c).ok, false); }
});
test('fast build matches the legacy index golden bytes except creation time', async t => {
  const f = await fixture(t, 3); const result = await updateSemanticIndex(f); delete result.createdAt;
  const expected = { version: 1, providerId: 'fake', providerFingerprint: 'fp', preprocessVersion: '1', dims: 1,
    fileHashes: { '0.md': '822beb0d1729878ad343b6c35b1d5e45e62f8e36b6543c2312b6f1cb6d00cdef', '1.md': '900a4469df00ccbfd0c145c6d1e4b7953dd0afafadd7534e3a4019e8d38fc663', '2.md': 'ad0387b3bd8652f730ca46d25f9c170af0fd589f42e7f23f5a9e6412d97d7e56' },
    entries: [{ path: '0.md', text: 'text 0', vector: [0] }, { path: '1.md', text: 'text 1', vector: [1] }, { path: '2.md', text: 'text 2', vector: [2] }] };
  assert.equal(JSON.stringify(result), JSON.stringify(expected));
});

test('cancellation keeps completed groups in the partial file, starts no new group and releases the lock', async t => {
  const f = await fixture(t, 8); const original = f.provider.embedDocuments; const controller = new AbortController(); let calls = 0;
  f.provider.embedDocuments = async texts => { if (++calls === 3) controller.abort(); return original(texts); };
  await assert.rejects(updateSemanticIndex({ ...f, indexBatchSize: 2, signal: controller.signal }), { code: 'E_SEMANTIC_ABORTED' });
  assert.equal(calls, 3, 'no group starts after the cancellation');
  const partial = JSON.parse(await readFile(partialPath(f), 'utf8'));
  assert.equal(Object.keys(partial.vectors).length, 4, 'groups completed before the cancelled one are kept; the cancelled group is not');
  assert.equal((await stat(partialPath(f))).mode & 0o777, 0o600);
  await assert.rejects(readFile(join(f.stateDir, 'semantic', 'index.lock')), { code: 'ENOENT' });
  assert.equal(await readSemanticIndex(f.stateDir), null);
  let resumed = 0; f.provider.embedDocuments = async texts => { resumed += texts.length; return original(texts); };
  const result = await updateSemanticIndex({ ...f, indexBatchSize: 2 });
  assert.equal(resumed, 4, 'the resumed run embeds only the missing chunks'); assert.equal(result.entries.length, 8);
});
test('cancellation before indexing starts creates no files and takes no lock', async t => {
  const f = await fixture(t, 2); const controller = new AbortController(); controller.abort();
  await assert.rejects(updateSemanticIndex({ ...f, signal: controller.signal }), { code: 'E_SEMANTIC_ABORTED' });
  await assert.rejects(stat(join(f.stateDir, 'semantic')), { code: 'ENOENT' });
});
test('a failed final partial write does not mask the provider error or the cancellation', async t => {
  for (const mode of ['provider', 'abort']) {
    const f = await fixture(t, 6); const original = f.provider.embedDocuments; const controller = new AbortController(); let calls = 0;
    const failure = Object.assign(new Error('provider failure'), { code: 'E_PROVIDER_FAILURE' });
    f.provider.embedDocuments = async texts => { if (++calls === 2) { if (mode === 'provider') throw failure; controller.abort(); } return original(texts); };
    // A directory in place of the partial file makes the final write fail with a state error.
    await mkdir(partialPath(f), { recursive: true });
    await assert.rejects(updateSemanticIndex({ ...f, indexBatchSize: 2, signal: controller.signal }), error => {
      assert.equal(error.code, mode === 'provider' ? 'E_PROVIDER_FAILURE' : 'E_SEMANTIC_ABORTED', mode);
      if (mode === 'provider') assert.equal(error, failure);
      return true;
    });
    await assert.rejects(readFile(join(f.stateDir, 'semantic', 'index.lock')), { code: 'ENOENT' }, `${mode}: lock released even when the write fails`);
  }
});
