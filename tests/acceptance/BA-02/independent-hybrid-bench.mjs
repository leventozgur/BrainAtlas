// SPDX-License-Identifier: MIT
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { pathToFileURL, fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WT = path.resolve(HERE, '../../..');
const repo = path.resolve(process.argv[2]);
const work = path.resolve(process.argv[3]);
const N = 2000,
  SEED = 1,
  QUERY_COUNT = 30,
  DIMS = 8;
const now = new Date('2026-11-10T00:00:00Z');

const core = await import(pathToFileURL(path.join(repo, 'packages/core/src/retrieval/index.mjs')).href);
const hybrid = await import(pathToFileURL(path.join(repo, 'modules/semantic/src/hybrid.mjs')).href);
const corpus = await import(pathToFileURL(path.join(WT, 'eval/lib/synthetic-corpus.mjs')).href);
const { loadPages, createSearcher } = core;
const { searchHybrid } = hybrid;

const vault = path.join(work, 'vault');
const stateDir = path.join(work, 'state');
fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(vault, { recursive: true });
fs.mkdirSync(stateDir, { recursive: true });
const { queries } = corpus.writeSyntheticCorpus(vault, { pages: N, seed: SEED, queryCount: QUERY_COUNT });
const vectors = corpus.fixedVectors(SEED, N, DIMS);
const relPaths = loadPages(vault).map((p) => p.path);
const entries = relPaths.map((p, i) => ({ path: p, vector: vectors[i], text: p, headingPath: '' }));
const queryVector = corpus.fixedVectors(SEED + 1, 1, DIMS)[0];
const provider = { fingerprint: 'ba02-independent-bench', embedQuery: async () => queryVector };

const isNew = typeof createSearcher({ vaultDir: vault, stateDir, now }).refreshIfChanged === 'function';
const searcher = isNew ? createSearcher({ vaultDir: vault, stateDir, now }) : null;
if (searcher) searcher.snapshot();

const times = [],
  digest = crypto.createHash('sha256');
for (const query of queries) {
  const start = performance.now();
  let results;
  if (isNew) {
    searcher.refreshIfChanged();
    const snap = searcher.snapshot();
    results = await searchHybrid({
      query,
      pages: snap.pages,
      lexicalIndex: snap.index,
      entries,
      provider,
      limit: 5,
      asOf: now,
    });
  } else {
    results = await searchHybrid({ query, pages: loadPages(vault), entries, provider, limit: 5, asOf: now });
  }
  times.push(performance.now() - start);
  digest.update(JSON.stringify([...results].map((r) => [r.path, r.score ?? null, r.rrfScore ?? null])) + '\n');
}
times.sort((a, b) => a - b);
const pct = (q) => times[Math.min(times.length - 1, Math.floor(q * times.length))];
console.log(
  JSON.stringify({
    root: repo,
    mode: isNew ? 'refreshIfChanged+snapshot+lexicalIndex' : 'loadPages+searchHybrid',
    n: N,
    count: times.length,
    p50: +pct(0.5).toFixed(3),
    p95: +pct(0.95).toFixed(3),
    digest: digest.digest('hex').slice(0, 16),
  })
);
