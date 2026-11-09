// SPDX-License-Identifier: MIT
// Acceptance (3), (4), (5): resume from partial file, fingerprint mismatch, force rebuild, read path isolation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, stat, symlink, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { updateSemanticIndex, buildSemanticIndex, readSemanticIndex, markdownChunks } from '../../../modules/semantic/src/index.mjs';
import { readPartialIndex, countPendingChunks } from '../../../modules/semantic/src/index-store.mjs';
import { exists, fakeClock, fakeProvider, normalizedIndexText, readJson, sectionPage, sha256, vecFor, workspace, snapshot } from './helpers.mjs';

const CHUNKS = 100;
async function setup(t, count = CHUNKS) {
  const w = await workspace(t, { 'page.md': sectionPage('Page', count), 'other.md': '# Other\n\n## Only\nsingle other chunk text\n' });
  w.partial = join(w.semanticDir, 'index.partial.json');
  w.index = join(w.semanticDir, 'index.json');
  w.lock = join(w.semanticDir, 'index.lock');
  w.chunkTexts = [];
  for (const file of ['other.md', 'page.md']) {
    const source = await readFile(join(w.wiki, file), 'utf8');
    w.chunkTexts.push(...markdownChunks(source, file).map(chunk => chunk.text));
  }
  w.total = w.chunkTexts.length;
  w.update = (provider, extra = {}) => updateSemanticIndex({ corpusDir: w.wiki, stateDir: w.stateDir, provider, chunkMarkdown: markdownChunks, now: provider.clock.now, ...extra });
  return w;
}

test('interruption at group k: error surfaces, partial holds the first k-1 groups, resume requests only the rest, result is identical to a one-shot build', async t => {
  const w = await setup(t);
  const failing = fakeProvider({ failOnCall: 3, durations: [1000] });
  await assert.rejects(w.update(failing), /fixture provider failure/u);
  assert.deepEqual(failing.sizes, [32, 32, 32], 'k=3 groups attempted at the default size');
  assert.equal(await exists(w.index), false, 'no final index after failure');
  assert.equal(await exists(w.lock), false, 'lock released in finally');

  const partial = await readJson(w.partial);
  assert.equal(partial.version, 1);
  assert.equal(partial.providerFingerprint, 'fp-a');
  assert.equal(partial.dims, 3);
  assert.equal(partial.preprocessVersion, '1');
  const doneTexts = failing.calls.slice(0, 2).flat();
  assert.equal(doneTexts.length, 64);
  assert.deepEqual(Object.keys(partial.vectors).sort(), doneTexts.map(sha256).sort(), 'exactly the vectors of groups 1..k-1, keyed by sha256(chunk text)');
  for (const text of doneTexts) assert.deepEqual(partial.vectors[sha256(text)], vecFor(text));
  assert.equal(JSON.stringify(partial).includes('lorem ipsum'), false, 'partial file never stores page text');
  assert.equal((await stat(w.partial)).mode & 0o777, 0o600);

  const resumed = fakeProvider({ durations: [1000] });
  const index = await w.update(resumed);
  assert.equal(resumed.texts.length, w.total - 64, 'only missing chunks are requested');
  assert.equal(resumed.texts.some(text => doneTexts.includes(text)), false, 'cached chunks are never re-requested');
  assert.equal(new Set(resumed.texts).size, resumed.texts.length);
  assert.equal(await exists(w.partial), false, 'partial deleted after the final index is written');
  assert.equal(await exists(w.lock), false);

  const oneShot = await setup(t);
  const reference = await oneShot.update(fakeProvider({ durations: [1000] }));
  assert.deepEqual(index.entries, reference.entries, 'entries and vectors identical');
  assert.deepEqual(index.fileHashes, reference.fileHashes);
  assert.equal(normalizedIndexText(await readFile(w.index, 'utf8')), normalizedIndexText(await readFile(oneShot.index, 'utf8')), 'byte-identical apart from createdAt');
});

test('repeated interruptions: across three runs every chunk is embedded exactly once', async t => {
  const w = await setup(t);
  const requested = [];
  const first = fakeProvider({ failOnCall: 2 }); await assert.rejects(w.update(first)); requested.push(...first.calls.slice(0, 1).flat());
  const second = fakeProvider({ failOnCall: 2 }); await assert.rejects(w.update(second)); requested.push(...second.calls.slice(0, 1).flat());
  assert.equal((await readJson(w.partial)).vectors && Object.keys((await readJson(w.partial)).vectors).length, 64);
  const third = fakeProvider({}); await w.update(third); requested.push(...third.texts);
  assert.equal(requested.length, w.total);
  assert.deepEqual([...new Set(requested)].sort(), [...new Set(w.chunkTexts)].sort());
  assert.equal(await exists(w.partial), false);
});

test('first group failing leaves no partial and no index', async t => {
  const w = await setup(t);
  await assert.rejects(w.update(fakeProvider({ failOnCall: 1 })));
  assert.equal(await exists(w.partial), false);
  assert.equal(await exists(w.index), false);
  assert.equal(await exists(w.lock), false);
});

test('checkpoint cadence: written no more often than every 30 s of injected time, and once the interval has elapsed', async t => {
  const fastObservations = [];
  const w1 = await setup(t);
  await w1.update(fakeProvider({ durations: [29000], onCall: async index => { fastObservations.push([index, await exists(w1.partial)]); }, failOnCall: null }), { indexBatchSize: 1 }).catch(() => {});
  // 29 s per group (< 30 s): the first group alone must not trigger a checkpoint.
  assert.deepEqual(fastObservations.slice(0, 2), [[1, false], [2, false]]);

  const w2 = await setup(t);
  const slowObservations = [];
  const p2 = fakeProvider({ durations: [31000], failOnCall: 4, onCall: async index => { slowObservations.push([index, await exists(w2.partial) ? Object.keys((await readJson(w2.partial)).vectors).length : 0]); } });
  await assert.rejects(w2.update(p2, { indexBatchSize: 2 }));
  assert.equal(slowObservations[0][1], 0, 'nothing before the first group completes');
  assert.ok(slowObservations[1][1] > 0, 'a 31 s group is checkpointed immediately');
  assert.ok(slowObservations[2][1] >= slowObservations[1][1], 'periodic checkpoint grows as groups complete');
});

test('abort (cancellation) during embedding persists the completed groups', async t => {
  const w = await setup(t);
  const controller = new AbortController();
  const provider = fakeProvider({ durations: [100], onCall: index => { if (index === 3) controller.abort(); } });
  await assert.rejects(w.update(provider, { signal: controller.signal }), { code: 'E_SEMANTIC_ABORTED' });
  assert.equal(await exists(w.lock), false, 'lock released on abort');
  assert.equal(await exists(w.index), false);
  const partial = await readPartialIndex(w.stateDir, provider);
  assert.ok(partial, 'partial file must exist after cancellation (spec: written on error/cancel in finally)');
  assert.equal(Object.keys(partial.vectors).length, 64, 'groups 1 and 2 were completed before the cancel');
});

test('already-aborted signal does no work', async t => {
  const w = await setup(t);
  const controller = new AbortController(); controller.abort();
  const provider = fakeProvider({});
  await assert.rejects(w.update(provider, { signal: controller.signal }), { code: 'E_SEMANTIC_ABORTED' });
  assert.equal(provider.calls.length, 0);
  assert.equal(await exists(w.semanticDir), false);
});

async function interrupted(t, w, options = {}) {
  await assert.rejects(w.update(fakeProvider({ failOnCall: 3, ...options })));
  assert.equal(Object.keys((await readJson(w.partial)).vectors).length, 64);
}

test('fingerprint, dims and preprocessVersion mismatches ignore the partial file and overwrite it', async t => {
  const variants = [
    { name: 'fingerprint', provider: { fingerprint: 'fp-b' } },
    { name: 'dims', provider: { dims: 4 } },
    { name: 'preprocessVersion', provider: { preprocessVersion: '2' } },
  ];
  for (const variant of variants) {
    const w = await setup(t);
    await interrupted(t, w);
    assert.equal(await countPendingChunks({ corpusDir: w.wiki, stateDir: w.stateDir, provider: fakeProvider(variant.provider), chunkMarkdown: markdownChunks }), w.total, `${variant.name}: pending count ignores partial`);
    const provider = fakeProvider(variant.provider);
    assert.equal(await readPartialIndex(w.stateDir, provider), null, `${variant.name}: readPartialIndex rejects`);
    const index = await w.update(provider);
    assert.equal(provider.texts.length, w.total, `${variant.name}: every chunk re-embedded`);
    assert.equal(index.entries.length, w.total);
    assert.equal(await exists(w.partial), false);
    assert.equal(index.providerFingerprint, provider.fingerprint);
    assert.ok(index.entries.every(entry => entry.vector.length === provider.dims));
  }
});

test('mismatched partial is overwritten, not merged, when the new run is interrupted', async t => {
  const w = await setup(t);
  await interrupted(t, w);
  const other = fakeProvider({ fingerprint: 'fp-b', failOnCall: 2 });
  await assert.rejects(w.update(other));
  const partial = await readJson(w.partial);
  assert.equal(partial.providerFingerprint, 'fp-b');
  assert.equal(Object.keys(partial.vectors).length, 32, 'only the new run vectors, none from the stale partial');
});

test('corrupt or malformed partial files are ignored without failing the run', async t => {
  const valid = vector => ({ version: 1, providerFingerprint: 'fp-a', dims: 3, preprocessVersion: '1', vectors: { [sha256('x')]: vector } });
  const bodies = [
    '{not json', '[]', 'null', JSON.stringify({ ...valid([1, 2, 3]), version: 2 }), JSON.stringify(valid([1, 2])), JSON.stringify(valid([1, 2, 'x'])),
    JSON.stringify(valid([1, 2, null])), JSON.stringify({ ...valid([1, 2, 3]), vectors: { nothex: [1, 2, 3] } }), JSON.stringify({ ...valid([1, 2, 3]), vectors: [] }),
    JSON.stringify({ ...valid([1, 2, 3]), vectors: null }), '',
  ];
  for (const body of bodies) {
    const w = await setup(t, 10);
    await mkdir(w.semanticDir, { recursive: true });
    await writeFile(w.partial, body);
    const provider = fakeProvider({});
    assert.equal(await readPartialIndex(w.stateDir, provider), null, body.slice(0, 30));
    const index = await w.update(provider);
    assert.equal(provider.texts.length, w.total);
    assert.equal(index.entries.length, w.total);
    assert.equal(await exists(w.partial), false);
  }
});

test('forced rebuild ignores and deletes a matching partial file', async t => {
  const w = await setup(t);
  await interrupted(t, w);
  const provider = fakeProvider({});
  const index = await buildSemanticIndex({ corpusDir: w.wiki, stateDir: w.stateDir, provider, chunkMarkdown: markdownChunks, now: provider.clock.now });
  assert.equal(provider.texts.length, w.total, 'force re-embeds everything');
  assert.equal(index.entries.length, w.total);
  assert.equal(await exists(w.partial), false);
});

test('forced rebuild that fails immediately still removes the stale partial and does not reuse it', async t => {
  const w = await setup(t);
  await interrupted(t, w);
  const provider = fakeProvider({ failOnCall: 1 });
  await assert.rejects(buildSemanticIndex({ corpusDir: w.wiki, stateDir: w.stateDir, provider, chunkMarkdown: markdownChunks, now: provider.clock.now }));
  assert.equal(await exists(w.partial), false, 'stale partial removed even though the rebuild failed');
  assert.equal(provider.calls[0].length, 32);
});

test('resume cache is content-addressed: edited chunks are re-requested, untouched chunks reused', async t => {
  const w = await setup(t, 40);
  await assert.rejects(w.update(fakeProvider({ failOnCall: 2 })));
  const cached = Object.keys((await readJson(w.partial)).vectors).length; assert.equal(cached, 32);
  const source = await readFile(join(w.wiki, 'other.md'), 'utf8');
  await writeFile(join(w.wiki, 'other.md'), source.replace('single other chunk text', 'edited other chunk text'));
  const provider = fakeProvider({});
  await w.update(provider);
  assert.ok(provider.texts.includes('edited other chunk text'));
  assert.ok(provider.texts.length <= 41 - 32 + 1, 'at most the non-cached remainder plus the edited chunk');
  assert.ok(provider.texts.length >= 41 - 32, 'the non-cached remainder is always requested');
});

test('a symlinked partial file is never read or written through', async t => {
  const w = await setup(t, 40);
  await mkdir(w.semanticDir, { recursive: true });
  const victim = join(w.root, 'victim.json');
  const content = JSON.stringify({ version: 1, providerFingerprint: 'fp-a', dims: 3, preprocessVersion: '1', vectors: { [sha256(w.chunkTexts[0])]: [9, 9, 9] } });
  await writeFile(victim, content);
  await symlink(victim, w.partial);
  const provider = fakeProvider({});
  assert.equal(await readPartialIndex(w.stateDir, provider), null);
  const outcome = await w.update(provider).then(() => 'ok', error => error.code);
  assert.ok(outcome === 'ok' || outcome === 'E_SEMANTIC_STATE', String(outcome));
  assert.equal(await readFile(victim, 'utf8'), content, 'symlink target untouched');
  assert.ok(!provider.texts.length || provider.texts.includes(w.chunkTexts[0]), 'vector from the symlink target was not trusted');
  if (outcome === 'ok') {
    const index = await readJson(w.index);
    assert.equal(index.entries.some(entry => entry.vector[0] === 9), false);
  }
});

test('a symlinked semantic directory is rejected and nothing is written outside', async t => {
  const w = await setup(t, 5);
  const outside = join(w.root, 'outside'); await mkdir(outside, { recursive: true });
  await mkdir(w.stateDir, { recursive: true });
  await symlink(outside, w.semanticDir);
  const provider = fakeProvider({});
  await assert.rejects(w.update(provider), { code: 'E_SEMANTIC_STATE' });
  assert.equal(provider.calls.length, 0);
  assert.deepEqual(await snapshot(outside), {});
});

test('a symlinked index.lock is rejected and its target is untouched', async t => {
  const w = await setup(t, 5);
  await mkdir(w.semanticDir, { recursive: true });
  const victim = join(w.root, 'lock-victim'); await writeFile(victim, 'keep');
  await symlink(victim, w.lock);
  const provider = fakeProvider({});
  await assert.rejects(w.update(provider), { code: 'E_SEMANTIC_STATE' });
  assert.equal(await readFile(victim, 'utf8'), 'keep');
  assert.equal(provider.calls.length, 0);
});

test('read path never sees the partial file: only-partial yields null, existing index is returned unchanged', async t => {
  const w = await setup(t, 40);
  await assert.rejects(w.update(fakeProvider({ failOnCall: 2 })));
  assert.equal(await exists(w.partial), true);
  assert.equal(await readSemanticIndex(w.stateDir), null, 'partial only: readSemanticIndex returns null');

  const complete = await setup(t, 40);
  const previous = await complete.update(fakeProvider({}));
  const bytes = await readFile(complete.index, 'utf8');
  // Change the corpus and get interrupted so a partial for the *new* state exists next to the old index.
  await writeFile(join(complete.wiki, 'page.md'), sectionPage('Page', 60, 'changed'));
  await assert.rejects(complete.update(fakeProvider({ failOnCall: 2 })));
  assert.equal(await exists(complete.partial), true);
  const seen = await readSemanticIndex(complete.stateDir);
  assert.deepEqual(seen, previous);
  assert.equal(await readFile(complete.index, 'utf8'), bytes, 'index.json untouched by the interrupted run');

  await writeFile(complete.partial, 'garbage');
  assert.deepEqual(await readSemanticIndex(complete.stateDir), previous);
  await unlink(complete.index);
  assert.equal(await readSemanticIndex(complete.stateDir), null);
});

test('a partial file never changes the file-hash reuse of a valid previous index', async t => {
  const w = await setup(t, 40);
  const provider = fakeProvider({});
  await w.update(provider);
  const again = fakeProvider({});
  const index = await w.update(again, { skipUnchangedWrite: true });
  assert.equal(again.calls.length, 0, 'unchanged corpus requires no embedding');
  assert.equal(index.entries.length, w.total);
  await writeFile(w.partial, JSON.stringify({ version: 1, providerFingerprint: 'fp-a', dims: 3, preprocessVersion: '1', vectors: {} }));
  const third = fakeProvider({});
  await w.update(third, { skipUnchangedWrite: true });
  assert.equal(third.calls.length, 0);
});

test('partial file mode stays 0600 even under a permissive umask-like starting state', async t => {
  const w = await setup(t);
  await assert.rejects(w.update(fakeProvider({ failOnCall: 2 })));
  await chmod(w.partial, 0o644);
  await assert.rejects(w.update(fakeProvider({ failOnCall: 2 })));
  assert.equal((await stat(w.partial)).mode & 0o777, 0o600, 'atomic rewrite restores owner-only mode');
});
