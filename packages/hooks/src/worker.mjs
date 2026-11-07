// SPDX-License-Identifier: MIT
import { parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs';
import { createSearcher } from '../../core/src/retrieval/index.mjs';
// The JS realpath implementation probes every ancestor, which the permission
// model rejects; the native implementation resolves the allowed vault directly.
if (process.permission) fs.realpathSync = fs.realpathSync.native;
try {
  const searcher = createSearcher(workerData.options);
  parentPort.postMessage({ results: searcher.search(workerData.query, workerData.searchOptions).results });
} catch { parentPort.postMessage({ error: true }); }
