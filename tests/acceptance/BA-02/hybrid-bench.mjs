// SPDX-License-Identifier: MIT
// BA-02 independent measurement (hypothesis 3): per-query cost of the MCP hybrid path.
// usage: node hybrid-bench.mjs <repoRoot> <old|new> [pages=2000] [queries=30] [passes=3]
//   old = loadPages(vault) + searchHybrid({pages, entries, ...})            (main's MCP path)
//   new = searcher.refreshIfChanged() + searcher.snapshot() + searchHybrid({pages, lexicalIndex, ...})
// Fake provider with fixed vectors; no network. Prints one JSON line.
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const [rootArg, mode, pagesArg = '2000', queriesArg = '30', passesArg = '3'] = process.argv.slice(2);
if (!rootArg || !['old', 'new'].includes(mode)) { console.error('usage'); process.exit(2); }
const root = resolve(rootArg);
const { loadPages, buildIndex, createSearcher } = await import(join(root, 'packages/core/src/retrieval/index.mjs'));
const { searchHybrid } = await import(join(root, 'modules/semantic/src/hybrid.mjs'));
const { writeSyntheticCorpus, fixedVectors } = await import(join(root, 'eval/lib/synthetic-corpus.mjs'));
const { percentile } = await import(join(root, 'eval/lib/metrics.mjs'));

const n = Number(pagesArg), qn = Math.max(30, Number(queriesArg)), passes = Number(passesArg), seed = 1, DIMS = 8;
const base = mkdtempSync(join(tmpdir(), 'ba02-hybrid-'));
try {
  const vault = join(base, 'vault'), stateDir = join(base, 'state');
  mkdirSync(vault); mkdirSync(stateDir);
  const { paths, queries } = writeSyntheticCorpus(vault, { pages: n, seed, queryCount: qn });
  const vectors = fixedVectors(seed, n, DIMS);
  const entries = paths.map((path, i) => ({ path, vector: vectors[i], text: path, headingPath: '' }));
  const queryVector = fixedVectors(seed + 1, 1, DIMS)[0];
  const provider = { fingerprint: 'ba02-bench', embedQuery: async () => queryVector };
  const searcher = mode === 'new' ? createSearcher({ vaultDir: vault, stateDir }) : null;

  const runOnce = async (query) => {
    if (mode === 'old') {
      const pages = loadPages(vault);
      return searchHybrid({ query, pages, entries, provider, limit: 5 });
    }
    searcher.refreshIfChanged();
    const snap = searcher.snapshot();
    return searchHybrid({ query, pages: snap.pages, lexicalIndex: snap.index, entries, provider, limit: 5 });
  };
  // Untimed warm-up pass, then timed passes.
  for (const q of queries) await runOnce(q);
  const times = [];
  const digest = createHash('sha256');
  for (let p = 0; p < passes; p++) {
    for (const q of queries) {
      const start = performance.now();
      const out = await runOnce(q);
      times.push(performance.now() - start);
      if (p === 0) digest.update(JSON.stringify([...out].map((r) => [r.path, r.rrfScore, r.semanticScore ?? null, r.score ?? null, r.snippet ?? null, r.sourceRanks ?? null])) + '\n');
    }
  }
  console.log(JSON.stringify({ root, mode, pages: n, queries: qn, passes, count: times.length,
    p50: percentile(times, 0.5), p95: percentile(times, 0.95), resultDigest: digest.digest('hex').slice(0, 16) }));
} finally {
  rmSync(base, { recursive: true, force: true });
}
