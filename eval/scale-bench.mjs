// SPDX-License-Identifier: MIT
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { buildIndex, createSearcher, loadPages } from '../packages/core/src/retrieval/index.mjs';
import { runHook } from '../packages/hooks/src/index.mjs';
import { searchHybrid } from '../modules/semantic/src/hybrid.mjs';
import { percentile } from './lib/metrics.mjs';
import { fixedVectors, writeSyntheticCorpus } from './lib/synthetic-corpus.mjs';
import { DEFAULT_NOW } from './hook-eval.mjs';

const MIN_QUERIES = 30;
const MIN_PROMPTS = 20;
const DEFAULT_SIZES = [500, 2000];
const DIMS = 8;

const stats = (values) => ({p50: percentile(values, 0.5), p95: percentile(values, 0.95), count: values.length});

async function timed(fn) {
  const start = performance.now();
  const value = await fn();
  return {value, ms: Math.max(0, performance.now() - start)};
}

/**
 * Measure retrieval and hook latency on deterministic synthetic vaults.
 * Timing values vary between runs; the synthetic content and queries do not.
 * @param {{sizes?:number[],seed?:number,queryCount?:number,hookCount?:number,now?:Date}} options
 */
export async function runScaleBench({sizes = DEFAULT_SIZES, seed = 1, queryCount = MIN_QUERIES, hookCount = MIN_PROMPTS, now = new Date(DEFAULT_NOW)} = {}) {
  if (!Array.isArray(sizes) || !sizes.length || sizes.some((n) => !Number.isInteger(n) || n < 1 || n > 50000)) throw new Error('Invalid sizes');
  const queries = Math.max(MIN_QUERIES, queryCount);
  const prompts = Math.max(MIN_PROMPTS, hookCount);
  const results = [];
  for (const n of sizes) {
    const root = mkdtempSync(join(tmpdir(), 'ba-scale-'));
    try {
      const vaultDir = join(root, 'vault');
      const stateDir = join(root, 'state');
      const hookStateDir = join(root, 'hook-state');
      mkdirSync(vaultDir);
      mkdirSync(hookStateDir);
      const {queries: queryList} = writeSyntheticCorpus(vaultDir, {pages: n, seed, queryCount: queries});
      const vaultPath = resolve(vaultDir);

      const buildIndexMs = (await timed(() => buildIndex(loadPages(vaultPath), {now}))).ms;
      const cold = await timed(() => createSearcher({vaultDir: vaultPath, stateDir, now}));
      const warm = await timed(() => createSearcher({vaultDir: vaultPath, stateDir, now}));

      const searchTimes = [];
      for (const query of queryList) {
        const {ms} = await timed(() => warm.value.search(query, {limit: 5, asOf: now}));
        searchTimes.push(ms);
      }

      const hookConfig = {vault: {path: vaultPath}, stateDir: hookStateDir, hooks: {mode: 'normal', deadlineMs: 4700}, retrieval: {abstainThreshold: 0}};
      const hookTimes = [];
      for (let i = 0; i < prompts; i++) {
        const stdin = JSON.stringify({session_id: `scale-${n}-${i}`, prompt: queryList[i % queryList.length]});
        const {ms} = await timed(() => runHook({client: 'claude', event: 'prompt', stdin, env: {}, config: hookConfig, now}));
        hookTimes.push(ms);
      }

      // Hybrid overhead: fake provider with fixed vectors, one chunk per page; loadPages runs per query like the MCP path.
      const vectors = fixedVectors(seed, n, DIMS);
      const relPaths = loadPages(vaultPath).map((page) => page.path);
      const entries = relPaths.map((path, i) => ({path, vector: vectors[i], text: path, headingPath: ''}));
      const queryVector = fixedVectors(seed + 1, 1, DIMS)[0];
      const provider = {fingerprint: 'scale-bench', embedQuery: async () => queryVector};
      const hybridTimes = [];
      for (const query of queryList) {
        const {ms} = await timed(() => searchHybrid({query, pages: loadPages(vaultPath), entries, provider, limit: 5, asOf: now}));
        hybridTimes.push(ms);
      }

      results.push({
        n,
        buildIndexMs,
        createSearcherColdMs: cold.ms,
        createSearcherWarmMs: warm.ms,
        searchMs: stats(searchTimes),
        hookMs: stats(hookTimes),
        hybridOverheadMs: stats(hybridTimes),
      });
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  }
  return {seed, sizes: results};
}

function parseArgs(args) {
  const options = {sizes: DEFAULT_SIZES};
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '--sizes' || i + 1 >= args.length || args[i + 1].startsWith('--')) throw new Error('Invalid arguments');
    const parts = args[++i].split(',');
    if (!parts.every((part) => /^\d+$/u.test(part))) throw new Error('Invalid sizes');
    options.sizes = parts.map(Number);
  }
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runScaleBench(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify(result));
  } catch {
    console.error('Scale bench failed');
    process.exitCode = 1;
  }
}
