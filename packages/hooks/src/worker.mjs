// SPDX-License-Identifier: MIT
import { parentPort, workerData } from 'node:worker_threads';
import { createSearcher } from '../../core/src/retrieval/index.mjs';
try {
  const searcher = createSearcher(workerData.options);
  parentPort.postMessage({ results: searcher.search(workerData.query, workerData.searchOptions).results });
} catch { parentPort.postMessage({ error: true }); }
