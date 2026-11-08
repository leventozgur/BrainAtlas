// SPDX-License-Identifier: MIT
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPages, buildIndex } from '../packages/core/src/retrieval/index.mjs';
import { buildSemanticIndex, createOllamaProvider, markdownChunks, cosineSimilarity, searchHybrid } from '../modules/semantic/src/index.mjs';
import { ndcg, reciprocalRank } from './lib/metrics.mjs';

const thresholds = [undefined, 0.3, 0.5, 0.7];
const margins = [undefined, 0.02, 0.05, 0.1];
function metrics(rows) {
  const answerable = rows.filter(({ item }) => !item.abstain && item.relevant?.length);
  const unanswerable = rows.filter(({ item }) => item.abstain || !item.relevant?.length);
  const mean = (items, fn) => items.length ? items.reduce((sum, row) => sum + fn(row), 0) / items.length : 0;
  return { answerable: answerable.length, recallAt5: mean(answerable, ({ item, results }) => results.slice(0, 5).filter(({ path }) => item.relevant.includes(path)).length / item.relevant.length),
    mrrAt10: mean(answerable, ({ item, results }) => reciprocalRank(results, item.relevant, 10)),
    ndcgAt10: mean(answerable, ({ item, results }) => ndcg(results, item.relevant)),
    unanswerable: unanswerable.length, abstainAccuracy: mean(unanswerable, ({ results }) => results.length === 0 ? 1 : 0),
    falseAnswerRate: mean(unanswerable, ({ results }) => results.length ? 1 : 0) };
}

/** Calibrate on supplied development cases using an injected provider. */
export async function calibrate({ corpusDir, casesFiles, provider, dumpScores = false }) {
  if (!provider || !Array.isArray(casesFiles) || !casesFiles.length) throw new TypeError('Invalid calibration configuration.');
  const sets = await Promise.all(casesFiles.map(async (file) => JSON.parse(await readFile(file, 'utf8'))));
  if (sets.some((set) => !Array.isArray(set))) throw new TypeError('Invalid calibration cases.');
  const cases = sets.flat();
  if (cases.some((item) => typeof item?.query !== 'string' || (item.relevant !== undefined && !Array.isArray(item.relevant)))) throw new TypeError('Invalid calibration cases.');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'semantic-calibrate-'));
  try {
    const pages = loadPages(corpusDir);
    const index = await buildSemanticIndex({ corpusDir, stateDir: temp, provider, chunkMarkdown: markdownChunks });
    const eligible = new Set(buildIndex(pages).docs.map(({ page }) => page.path));
    const prepared = [];
    for (const [i, item] of cases.entries()) {
      const vector = typeof provider.embedQuery === 'function' ? await provider.embedQuery(item.query) : (await provider.embed([item.query]))[0];
      const best = new Map();
      for (const entry of index.entries) if (eligible.has(entry.path)) {
        const score = cosineSimilarity(vector, entry.vector);
        if (!best.has(entry.path) || score > best.get(entry.path)) best.set(entry.path, score);
      }
      const scores = [...best.values()].sort((a, b) => b - a);
      prepared.push({ item, vector, id: typeof item.id === 'string' && /^[a-zA-Z0-9_-]{1,64}$/u.test(item.id) ? item.id : `case-${i + 1}`, top: scores[0] ?? null, margin: scores.length > 1 ? scores[0] - scores[1] : scores.length ? 2 : null });
    }
    const combinations = [];
    for (const mode of ['rrf', 'semantic-primary']) for (const weights of [[1, 1], [1, 2], [1, 3]]) for (const minSemanticScore of thresholds) for (const minMargin of margins) {
      const rows = [];
      for (const { item, vector } of prepared) {
        const results = await searchHybrid({ query: item.query, pages, entries: index.entries, provider: { embedQuery: async () => vector }, limit: 10, mode, weights, minSemanticScore, minMargin });
        if (results.fallbackReason) throw new Error('Hybrid semantic retrieval failed.');
        rows.push({ item, results });
      }
      combinations.push({ mode, weights, minSemanticScore: minSemanticScore ?? null, minMargin: minMargin ?? null, ...metrics(rows), crossLanguage: metrics(rows.filter(({ item }) => item.trToEn || item.enToTr || item.crossLanguage || /^xling(?:-|$)/u.test(item.category ?? ''))) });
    }
    const eligibleResults = combinations.filter((row) => row.unanswerable > 0 && row.abstainAccuracy >= 0.8);
    const complexity = (row) => (row.weights[1] - 1) + (row.minSemanticScore === null ? 0 : 10) + (row.minMargin === null ? 0 : 10);
    eligibleResults.sort((a, b) => b.ndcgAt10 - a.ndcgAt10 || complexity(a) - complexity(b));
    return { combinations, recommended: eligibleResults[0] ?? null, ...(dumpScores ? { scores: prepared.map(({ id, top, margin }) => ({ id, topCosine: top, margin })) } : {}) };
  } finally { await rm(temp, { recursive: true, force: true }); }
}

const usage = 'Usage: node eval/semantic-calibrate.mjs --corpus DIR --cases FILE[,FILE...] --model NAME --base-url URL [--query-prefix S] [--doc-prefix S] [--dims N] [--dump-scores] [--json]';
function parseArgs(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const values = new Set(['--corpus', '--cases', '--model', '--base-url', '--query-prefix', '--doc-prefix', '--dims']);
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--json' || key === '--dump-scores') { options[key.slice(2)] = true; continue; }
    if (!values.has(key) || i + 1 >= args.length || args[i + 1].startsWith('--')) throw new Error('Invalid arguments.');
    options[key.slice(2)] = args[++i];
  }
  if (!options.corpus || !options.cases || !options.model || !options['base-url'] || options.cases.split(',').some((s) => !s) || (options.dims !== undefined && !/^[1-9]\d*$/u.test(options.dims))) throw new Error('Invalid arguments.');
  return options;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) console.log(usage);
    else {
      const provider = createOllamaProvider({ model: args.model, baseUrl: args['base-url'], dims: args.dims ? Number(args.dims) : 768, queryPrefix: args['query-prefix'], documentPrefix: args['doc-prefix'] });
      const result = await calibrate({ corpusDir: args.corpus, casesFiles: args.cases.split(','), provider, dumpScores: args['dump-scores'] });
      if (args.json) console.log(JSON.stringify(result));
      else {
        console.log('mode weights score margin recall@5 MRR@10 nDCG@10 cross-recall@5 cross-MRR@10 cross-nDCG@10 abstain-accuracy false-answer-rate');
        for (const row of result.combinations) console.log(`${row.mode} ${row.weights.join(':')} ${row.minSemanticScore ?? '-'} ${row.minMargin ?? '-'} ${row.recallAt5.toFixed(3)} ${row.mrrAt10.toFixed(3)} ${row.ndcgAt10.toFixed(3)} ${row.crossLanguage.recallAt5.toFixed(3)} ${row.crossLanguage.mrrAt10.toFixed(3)} ${row.crossLanguage.ndcgAt10.toFixed(3)} ${row.abstainAccuracy.toFixed(3)} ${row.falseAnswerRate.toFixed(3)}`);
        console.log(`Recommended: ${JSON.stringify(result.recommended)}`);
        if (result.scores) console.log(`Scores: ${JSON.stringify(result.scores)}`);
      }
    }
  } catch { console.error('Calibration failed: check arguments, corpus, cases, and provider.'); process.exitCode = 1; }
}
