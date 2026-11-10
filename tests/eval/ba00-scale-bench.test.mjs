// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runScaleBench } from '../../eval/scale-bench.mjs';
import { createRng, writeSyntheticCorpus } from '../../eval/lib/synthetic-corpus.mjs';

const finiteStats = (stats, count) => {
  assert.deepEqual(Object.keys(stats).sort(), ['count', 'p50', 'p95']);
  assert.ok(Number.isFinite(stats.p50) && Number.isFinite(stats.p95));
  assert.ok(stats.p95 >= stats.p50);
  assert.ok(stats.count >= count, `count ${stats.count} < ${count}`);
};

test('synthetic corpus generation is deterministic for a seed and free of real-looking identifiers', (t) => {
  const first = fs.mkdtempSync(path.join(os.tmpdir(), 'ba00-synth-a-'));
  const second = fs.mkdtempSync(path.join(os.tmpdir(), 'ba00-synth-b-'));
  t.after(() => { fs.rmSync(first, {recursive: true, force: true}); fs.rmSync(second, {recursive: true, force: true}); });
  const a = writeSyntheticCorpus(first, {pages: 12, seed: 7, queryCount: 5});
  const b = writeSyntheticCorpus(second, {pages: 12, seed: 7, queryCount: 5});
  assert.deepEqual(a, b);
  assert.equal(a.paths.length, 12);
  assert.equal(a.queries.length, 5);
  for (const relPath of a.paths) {
    assert.equal(fs.readFileSync(path.join(first, relPath), 'utf8'), fs.readFileSync(path.join(second, relPath), 'utf8'));
  }
  const rng1 = createRng(42); const rng2 = createRng(42);
  assert.deepEqual([rng1(), rng1(), rng1()], [rng2(), rng2(), rng2()]);
  assert.throws(() => writeSyntheticCorpus(first, {pages: 0}), /Invalid page count/);
});

test('scale bench smoke run at N=50 reports every key with the minimum sample counts', async () => {
  const result = await runScaleBench({sizes: [50]});
  assert.equal(result.seed, 1);
  assert.equal(result.sizes.length, 1);
  const [row] = result.sizes;
  assert.equal(row.n, 50);
  for (const key of ['buildIndexMs', 'createSearcherColdMs', 'createSearcherWarmMs']) assert.ok(Number.isFinite(row[key]) && row[key] >= 0, key);
  finiteStats(row.searchMs, 30);
  finiteStats(row.hookMs, 20);
  finiteStats(row.hybridOverheadMs, 30);
});

test('scale bench rejects invalid sizes', async () => {
  await assert.rejects(() => runScaleBench({sizes: []}), /Invalid sizes/);
  await assert.rejects(() => runScaleBench({sizes: [0]}), /Invalid sizes/);
  await assert.rejects(() => runScaleBench({sizes: [1.5]}), /Invalid sizes/);
});
