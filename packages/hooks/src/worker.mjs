// SPDX-License-Identifier: MIT
import { parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs';
import { createSearcher } from '../../core/src/retrieval/index.mjs';
import { redact } from '../../core/src/safety/index.mjs';
import { semanticHits } from './semantic.mjs';
if (process.permission) fs.realpathSync = /** @type {any} */ (fs.realpathSync.native);
const EXCERPT_LIMIT = 4002;
function capExcerpt(text) {
  let end = Math.min(text.length, EXCERPT_LIMIT);
  if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1])) end--;
  return text.slice(0, end);
}
const finish = (result) => ({ ...result, snippet: capExcerpt(redact(result.snippet)) });
function shadowDiff(baseline, searcher, query, searchOptions, threshold) {
  try {
    const a = baseline.slice(0, 5).map((result) => result.path);
    let b;
    if (a.length && threshold <= (searchOptions.abstainThreshold ?? 0)) b = a;
    else if (a.length)
      b = searcher.search(query, { ...searchOptions, limit: 1, budgetChars: 0, abstainThreshold: threshold }).results
        .length
        ? a
        : [];
    else
      b = searcher
        .search(query, { ...searchOptions, limit: 5, budgetChars: 0, abstainThreshold: threshold })
        .results.slice(0, 5)
        .map((result) => result.path);
    return {
      top1Same: a[0] === b[0],
      overlap5: a.filter((path, index) => b.includes(path) && a.indexOf(path) === index).length,
      injectDiff: a.length > 0 !== b.length > 0,
    };
  } catch {
    return null;
  }
}
try {
  const searcher = createSearcher(workerData.options);
  const lexical = searcher.search(workerData.query, workerData.searchOptions).results.map(finish);
  const shadow =
    workerData.shadowThreshold === undefined
      ? null
      : shadowDiff(lexical, searcher, workerData.query, workerData.searchOptions, workerData.shadowThreshold);
  if (!workerData.semantic) parentPort.postMessage({ results: lexical, ...(shadow ? { shadow } : {}) });
  else {
    const { searchOptions, query, semantic } = workerData;
    const hit = await semanticHits({
      ...semantic,
      searcher,
      query,
      limit: searchOptions.limit,
      abstainThreshold: searchOptions.abstainThreshold,
      lexical,
      prepare: finish,
    });
    parentPort.postMessage({ results: hit.results, semantic: hit.semantic, ...(shadow ? { shadow } : {}) });
  }
} catch {
  parentPort.postMessage({ error: true });
}
