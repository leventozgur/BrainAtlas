// SPDX-License-Identifier: MIT
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { buildIndex, loadPages, search } from '../packages/core/src/retrieval/index.mjs';
import { scanText } from '../packages/core/src/safety/index.mjs';

const redactSensitive = (value) => scanText(value).length ? '[redacted]' : value;
const safeCaseId = (item, index) => redactSensitive(typeof item?.id === 'string' && /^[\w-]{1,64}$/u.test(item.id) ? item.id : String(index + 1));
const reciprocalRank = (results, relevant, limit) => {
  const rank = results.slice(0, limit).findIndex((result) => relevant.includes(result.path));
  return rank < 0 ? 0 : 1 / (rank + 1);
};
const ndcg = (results, relevant) => {
  let dcg = 0;
  for (const [index, result] of results.slice(0, 10).entries()) {
    if (relevant.includes(result.path)) dcg += 1 / Math.log2(index + 2);
  }
  const idealCount = Math.min(relevant.length, 10);
  let ideal = 0;
  for (let index = 0; index < idealCount; index++) ideal += 1 / Math.log2(index + 2);
  return ideal ? dcg / ideal : 0;
};
const percentile = (values, p) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
};

/**
 * Evaluate retrieval metrics. Existing metric semantics and keys are preserved.
 * @param {{corpusDir:string,casesFile:string,now?:Date,verbose?:boolean,repeat?:number,abstainThreshold?:number}} options
 */
export function runEval({corpusDir, casesFile, now = new Date(), verbose = false, repeat = 3, abstainThreshold = 0, rejectInvalidQueries = false}) {
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 1000) throw new Error('Invalid repeat');
  if (typeof abstainThreshold !== 'number' || !Number.isFinite(abstainThreshold) || abstainThreshold < 0 || abstainThreshold > 1) throw new Error('Invalid abstain threshold');
  const cases = JSON.parse(readFileSync(casesFile, 'utf8'));
  if (!Array.isArray(cases)) throw new Error('Invalid cases');
  const buildStart = performance.now();
  const index = buildIndex(loadPages(corpusDir), {now});
  const indexBuildMs = performance.now() - buildStart;
  let recall = 0, precision = 0, answerable = 0, abstainRight = 0, abstainCount = 0, trRecall = 0, trCount = 0;
  let reciprocal = 0, ndcgTotal = 0, rankedCount = 0;
  const categories = new Map();
  const timings = [];
  const falsePositives = [];

  for (const [i, item] of cases.entries()) {
    const relevant = Array.isArray(item?.relevant) ? item.relevant : [];
    const abstain = Boolean(item?.abstain || !relevant.length);
    const category = typeof item?.category === 'string' && Array.from(item.category).length <= 64 && /^[\p{L}\p{N}\p{Zs}_-]+$/u.test(item.category) ? item.category : 'uncategorized';
    let categoryMetrics = categories.get(category);
    if (!categoryMetrics) {
      categoryMetrics = {n: 0, recall: 0, reciprocal: 0, answerable: 0};
      categories.set(category, categoryMetrics);
    }
    categoryMetrics.n++;

    if (rejectInvalidQueries && typeof item?.query !== 'string') throw new Error('Invalid query');

    // Warm the same query once without including that call in reported latency.
    let result;
    try { result = search(index, item.query, {limit:10, asOf:now, abstainThreshold}); } catch { result = null; }
    for (let attempt = 0; attempt < repeat; attempt++) {
      const start = performance.now();
      try { result = search(index, item.query, {limit:10, asOf:now, abstainThreshold}); } catch { result = null; }
      timings.push(Math.max(0, performance.now() - start));
    }

    const results = result?.results || [];
    const hits = results.slice(0, 5).filter((entry) => relevant.includes(entry.path)).length;
    const rr = reciprocalRank(results, relevant, 10);
    const excluded = Array.isArray(item?.excluded) ? item.excluded : [];
    const excludedHits = results.filter((entry) => excluded.includes(entry.path));
    const caseId = safeCaseId(item, i);
    if (abstain && results.length) falsePositives.push({caseId, path: redactSensitive(results[0].path)});
    for (const entry of excludedHits) falsePositives.push({caseId, path: redactSensitive(entry.path)});

    if (abstain) {
      abstainCount++;
      if (result?.abstained) abstainRight++;
    } else {
      answerable++;
      const caseRecall = hits / relevant.length;
      recall += caseRecall;
      precision += hits / 5;
      reciprocal += rr;
      ndcgTotal += ndcg(results, relevant);
      rankedCount++;
      categoryMetrics.answerable++;
      categoryMetrics.recall += caseRecall;
      categoryMetrics.reciprocal += rr;
      if (item?.trToEn) { trCount++; trRecall += caseRecall; }
    }
    if (verbose && (!result || excludedHits.length || (abstain ? !result.abstained : hits < relevant.length))) {
      console.error(`case ${caseId}`);
    }
  }

  const byCategory = Object.fromEntries([...categories.entries()].sort(([a], [b]) => a.localeCompare(b, 'en')).map(([category, metrics]) => [category, {
    n: metrics.n,
    recallAt5: metrics.answerable ? metrics.recall / metrics.answerable : 0,
    mrrAt10: metrics.answerable ? metrics.reciprocal / metrics.answerable : 0,
  }]));
  return {
    recallAt5: answerable ? recall / answerable : 0,
    precisionAt5: answerable ? precision / answerable : 0,
    abstainAccuracy: abstainCount ? abstainRight / abstainCount : 0,
    trToEnRecallAt5: trCount ? trRecall / trCount : 0,
    n: cases.length,
    abstainThreshold,
    mrrAt10: rankedCount ? reciprocal / rankedCount : 0,
    ndcgAt10: rankedCount ? ndcgTotal / rankedCount : 0,
    latencyMs: {p50: percentile(timings, 0.5), p95: percentile(timings, 0.95), count: timings.length},
    indexBuildMs,
    byCategory,
    falsePositives,
  };
}

function parseArgs(args) {
  const options = {verbose: args.includes('--verbose'), json: args.includes('--json'), repeat: 3, abstainThreshold: 0};
  const valueFlags = new Set(['--corpus', '--cases', '--now', '--repeat', '--abstain-threshold']);
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--verbose' || flag === '--json') continue;
    if (!valueFlags.has(flag) || i + 1 >= args.length || args[i + 1].startsWith('--')) throw new Error('Invalid arguments');
    const value = args[++i];
    if (flag === '--repeat') {
      if (!/^\d+$/u.test(value)) throw new Error('Invalid repeat');
      options.repeat = Number(value);
    } else if (flag === '--abstain-threshold') {
      if (!value.trim()) throw new Error('Invalid abstain threshold');
      options.abstainThreshold = Number(value);
      if (!Number.isFinite(options.abstainThreshold) || options.abstainThreshold < 0 || options.abstainThreshold > 1) throw new Error('Invalid abstain threshold');
    } else options[flag.slice(2)] = value;
  }
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const base = fileURLToPath(new URL('.', import.meta.url));
    const result = runEval({
      corpusDir: args.corpus || resolve(base, 'corpus'),
      casesFile: args.cases || resolve(base, 'dev/cases.json'),
      now: args.now ? new Date(args.now) : new Date(),
      verbose: args.verbose,
      repeat: args.repeat,
      abstainThreshold: args.abstainThreshold,
      rejectInvalidQueries: true,
    });
    console.log(JSON.stringify(result, null, args.json ? 0 : 2));
  } catch {
    console.error('Eval failed');
    process.exitCode = 1;
  }
}
