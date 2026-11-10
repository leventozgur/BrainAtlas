// SPDX-License-Identifier: MIT
// BA-00 blind acceptance: scale-bench output shape at small N, temp cleanup, no network, synthetic corpus determinism.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { writeSyntheticCorpus, fixedVectors } from '../../../eval/lib/synthetic-corpus.mjs';
import { ROOT, runNode, tempDir, removeDir, listDir } from './helpers.mjs';

const BENCH = join(ROOT, 'eval', 'scale-bench.mjs');

// Map of relative path -> file content for every file under dir.
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out[p.slice(dir.length + 1)] = readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return out;
}

test('scale-bench: small N run returns the documented shape with the minimum query and prompt counts', () => {
  const home = tempDir('bench-home');
  const tmp = tempDir('bench-tmp');
  const netLog = join(tmp, 'net.log');
  const stateless = join(tmp, 'netlog-dir');
  mkdirSync(stateless);
  try {
    const res = runNode([BENCH, '--sizes', '30,60'], {
      preload: true,
      env: { HOME: home, TMPDIR: tmp, BA00_NET_LOG: join(stateless, 'net.log') },
    });
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.equal(out.seed, 1);
    assert.deepEqual(out.sizes.map((x) => x.n), [30, 60]);
    for (const row of out.sizes) {
      assert.deepEqual(Object.keys(row).sort(), ['buildIndexMs', 'createSearcherColdMs', 'createSearcherWarmMs', 'hookMs', 'hybridOverheadMs', 'n', 'searchMs'].sort());
      for (const f of ['buildIndexMs', 'createSearcherColdMs', 'createSearcherWarmMs']) assert.ok(Number.isFinite(row[f]) && row[f] >= 0, f);
      assert.equal(row.searchMs.count, 30, 'search queries (min 30)');
      assert.equal(row.hookMs.count, 20, 'hook prompts (min 20)');
      assert.equal(row.hybridOverheadMs.count, 30, 'hybrid queries (min 30)');
      for (const f of ['searchMs', 'hookMs', 'hybridOverheadMs']) {
        assert.ok(row[f].p50 >= 0 && row[f].p95 >= row[f].p50, `${f} percentiles ordered`);
      }
    }
    assert.deepEqual(listDir(tmp).filter((x) => x !== 'netlog-dir'), [], 'scale temp dirs removed');
    assert.deepEqual(listDir(home), [], 'HOME untouched');
    assert.equal(existsSync(join(stateless, 'net.log')), false, 'no network attempt');
    assert.equal(existsSync(netLog), false);
  } finally {
    removeDir(home);
    removeDir(tmp);
  }
});

test('scale-bench: invalid --sizes exit 1 with a generic message and no JSON on stdout', () => {
  for (const args of [['--sizes', '0'], ['--sizes', '1,x'], ['--sizes'], ['--bogus']]) {
    const res = runNode([BENCH, ...args]);
    assert.notEqual(res.status, 0, `args ${args.join(' ')}`);
    assert.equal(res.stdout, '', `args ${args.join(' ')}`);
  }
  const zero = runNode([BENCH, '--sizes', '0']);
  assert.equal(zero.status, 1);
  assert.match(zero.stderr, /Scale bench failed/);
});

test('synthetic corpus: same seed gives byte-identical pages and queries; a different seed does not', () => {
  const a = tempDir('synth-a');
  const b = tempDir('synth-b');
  const c = tempDir('synth-c');
  try {
    const ra = writeSyntheticCorpus(a, { pages: 25, seed: 7, queryCount: 30 });
    const rb = writeSyntheticCorpus(b, { pages: 25, seed: 7, queryCount: 30 });
    const rc = writeSyntheticCorpus(c, { pages: 25, seed: 8, queryCount: 30 });
    assert.deepEqual(ra.queries, rb.queries);
    assert.deepEqual(snapshot(a), snapshot(b));
    assert.notDeepEqual(ra.queries, rc.queries);
    assert.equal(ra.paths.length, 25);
    assert.equal(ra.queries.length, 30);
    assert.deepEqual(fixedVectors(3, 4, 8), fixedVectors(3, 4, 8));
    const bad = tempDir('synth-bad');
    try {
      assert.throws(() => writeSyntheticCorpus(bad, { pages: 0 }), /Invalid page count/);
    } finally {
      removeDir(bad);
    }
  } finally {
    removeDir(a);
    removeDir(b);
    removeDir(c);
  }
});
