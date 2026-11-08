// SPDX-License-Identifier: MIT
import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { scanText } from '../packages/core/src/safety/index.mjs';
import { buildIndex, loadPages, search } from '../packages/core/src/retrieval/index.mjs';
import { buildSemanticIndex, createOllamaProvider, markdownChunks, cosineSimilarity, searchHybrid } from '../modules/semantic/src/index.mjs';
import { reciprocalRank, ndcg, percentile } from './lib/metrics.mjs';

const metricNames = ['recallAt5', 'precisionAt5', 'mrrAt10', 'ndcgAt10'];
function aggregate(rows) {
  const answerable = rows.filter(({ item }) => !item.abstain && Array.isArray(item.relevant) && item.relevant.length);
  const totals = Object.fromEntries(metricNames.map((name) => [name, 0]));
  for (const { item, results } of answerable) {
    const hits = results.slice(0, 5).filter((result) => item.relevant.includes(result.path)).length;
    totals.recallAt5 += hits / item.relevant.length;
    totals.precisionAt5 += hits / 5;
    totals.mrrAt10 += reciprocalRank(results, item.relevant, 10);
    totals.ndcgAt10 += ndcg(results, item.relevant);
  }
  for (const name of metricNames) totals[name] = answerable.length ? totals[name] / answerable.length : 0;
  return { ...totals, n: rows.length, answerable: answerable.length, abstain: rows.length - answerable.length };
}
function report(rows) {
  const groups = new Map();
  for (const row of rows) {
    const c = row.item.category;
    const category = typeof c === 'string' && Array.from(c).length <= 64 && /^[\p{L}\p{N}\p{Zs}_-]+$/u.test(c) && !scanText(c).length ? c : 'uncategorized';
    if (!groups.has(category)) groups.set(category, []);
    groups.get(category).push(row);
  }
  return { ...aggregate(rows), trToEn: aggregate(rows.filter(({ item }) => item.trToEn)),
    byCategory: Object.fromEntries([...groups].sort(([a], [b]) => a.localeCompare(b, 'en')).map(([name, group]) => [name, aggregate(group)])) };
}
const timings = (values) => ({ p50: percentile(values, 0.5), p95: percentile(values, 0.95) });

/** Evaluate identical cases with an injected provider; no network is used except by that provider. */
export async function runSemanticEval({ corpusDir, casesFile, provider, limit = 5 }) {
  if (!provider || !Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid evaluation configuration.');
  const cases = JSON.parse(await readFile(casesFile, 'utf8'));
  if (!Array.isArray(cases) || cases.some((item) => typeof item?.query !== 'string')) throw new Error('Invalid evaluation cases.');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'semantic-eval-'));
  try {
    const pages = loadPages(corpusDir);
    const start = performance.now();
    const lexicalIndex = buildIndex(pages);
    let embedDocsMs = 0;
    const wrapped = { ...provider, embedDocuments: async (texts) => {
      const began = performance.now();
      try { return await (provider.embedDocuments ?? provider.embed).call(provider, texts); }
      finally { embedDocsMs += performance.now() - began; }
    } };
    const index = await buildSemanticIndex({ corpusDir, stateDir: temp, provider: wrapped, chunkMarkdown: markdownChunks });
    const indexBuildMs = performance.now() - start;
    const eligible = new Set(lexicalIndex.docs.map(({ page }) => page.path));
    const rows = { lexical: [], semantic: [], hybrid: [] };
    const queryEmbedTimes = [], queryTimes = [];
    for (const item of cases) {
      const queryStart = performance.now();
      const embedStart = performance.now();
      const vector = typeof provider.embedQuery === 'function' ? await provider.embedQuery(item.query) : (await provider.embed([item.query]))[0];
      queryEmbedTimes.push(performance.now() - embedStart);
      const lexical = search(lexicalIndex, item.query, { limit: Math.max(limit, 10, 20), abstainThreshold: 0 }).results;
      const best = new Map();
      for (const entry of index.entries) {
        if (!eligible.has(entry.path)) continue;
        const score = cosineSimilarity(vector, entry.vector);
        if (!best.has(entry.path) || score > best.get(entry.path).score) best.set(entry.path, { path: entry.path, score });
      }
      const semantic = [...best.values()].sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
      const hybrid = await searchHybrid({ query: item.query, pages, entries: index.entries, provider: { embedQuery: async () => vector }, limit: Math.max(limit, 10) });
      if (hybrid.fallbackReason) throw new Error('Hybrid semantic retrieval failed.');
      // At least ten ranks are needed for MRR/nDCG, independent of display limit.
      const cap = Math.max(limit, 10);
      for (const [name, results] of Object.entries({ lexical, semantic, hybrid })) rows[name].push({ item, results: results.slice(0, cap) });
      queryTimes.push(performance.now() - queryStart);
    }
    const modes = Object.fromEntries(Object.entries(rows).map(([name, values]) => [name, report(values)]));
    const delta = (a, b) => Object.fromEntries(metricNames.map((name) => [name, a[name] - b[name]]));
    const deltaVsLexical = { ...delta(modes.hybrid, modes.lexical), trToEn: delta(modes.hybrid.trToEn, modes.lexical.trToEn),
      byCategory: Object.fromEntries(Object.keys(modes.lexical.byCategory).map((name) => [name, delta(modes.hybrid.byCategory[name], modes.lexical.byCategory[name])])) };
    return { ...modes, deltaVsLexical, timing: { indexBuildMs, embedDocsMs, queryEmbedMs: timings(queryEmbedTimes), queryMs: timings(queryTimes) },
      index: { chunks: index.entries.length, jsonBytes: Buffer.byteLength(`${JSON.stringify(index)}\n`), dims: index.dims } };
  } finally { await rm(temp, { recursive: true, force: true }); }
}

const help = `Usage: node eval/semantic-eval.mjs --corpus DIR --cases FILE --model NAME [--base-url URL] [--query-prefix S] [--doc-prefix S] [--dims N] [--limit 5] [--json]
Example prefixes (supply explicitly):
  embeddinggemma: --query-prefix 'task: search result | query: ' --doc-prefix 'title: none | text: '
  multilingual-e5-small: --query-prefix 'query: ' --doc-prefix 'passage: '
  qwen3-embedding:0.6b: --query-prefix 'Instruct: Given a search query, retrieve relevant passages that answer the query\nQuery: '
`;
function parseArgs(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const values = new Set(['--corpus', '--cases', '--model', '--base-url', '--query-prefix', '--doc-prefix', '--dims', '--limit']);
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--json') { options.json = true; continue; }
    if (!values.has(flag) || i + 1 >= args.length || args[i + 1].startsWith('--')) throw new Error('Invalid arguments. Use --help for usage.');
    options[flag.slice(2)] = args[++i];
  }
  if (!options.corpus || !options.cases || !options.model || (options.dims !== undefined && !/^[1-9]\d*$/u.test(options.dims)) || (options.limit !== undefined && !/^[1-9]\d*$/u.test(options.limit))) throw new Error('Invalid arguments. Use --help for usage.');
  return options;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) console.log(help);
    else {
      if (args.model === 'embeddinggemma' && args['query-prefix'] === undefined && args['doc-prefix'] === undefined) console.error('Warning: no prefixes supplied; results may not be fair.');
      const provider = createOllamaProvider({ model: args.model, baseUrl: args['base-url'], dims: args.dims === undefined ? 768 : Number(args.dims), queryPrefix: args['query-prefix'], documentPrefix: args['doc-prefix'] });
      const result = await runSemanticEval({ corpusDir: args.corpus, casesFile: args.cases, provider, limit: args.limit === undefined ? 5 : Number(args.limit) });
      console.log(JSON.stringify(result, null, args.json ? 0 : 2));
    }
  } catch (error) {
    const providerMessages = { 'Embedding model unavailable.': 'Embedding failed: model unavailable; check the model name and local installation.', 'Embedding provider returned an invalid vector.': 'Embedding failed: invalid vector or dimension mismatch; check --dims.', 'Embedding provider timed out.': 'Embedding failed: provider timed out while loading or embedding.', 'Embedding provider request failed.': 'Embedding failed: Ollama unavailable or request rejected; check the service and model.' };
    const message = error?.code === 'E_SEMANTIC_PROVIDER' ? (providerMessages[error.message] ?? 'Embedding failed: check provider configuration and response.') : error?.message === 'Invalid arguments. Use --help for usage.' ? error.message : 'Semantic evaluation failed: check corpus, cases, and configuration.';
    console.error(message);
    process.exitCode = 1;
  }
}
