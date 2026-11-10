// SPDX-License-Identifier: MIT
import { parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs';
import { createSearcher } from '../../core/src/retrieval/index.mjs';
import { redact } from '../../core/src/safety/index.mjs';
// The JS realpath implementation probes every ancestor, which the permission
// model rejects; the native implementation resolves the allowed vault directly.
if (process.permission) fs.realpathSync = fs.realpathSync.native;
// No prompt block can exceed the largest output cap (4002), so an excerpt longer than that is never posted.
// Redaction runs first so that truncation can never leave part of a secret in the message.
const EXCERPT_LIMIT = 4002;
// Cut at a code point boundary: never keep a lone high surrogate at the end.
function capExcerpt(text) {
  let end = Math.min(text.length, EXCERPT_LIMIT);
  if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1])) end--;
  return text.slice(0, end);
}
try {
  const searcher = createSearcher(workerData.options);
  const results = searcher.search(workerData.query, workerData.searchOptions).results
    .map(result => ({ ...result, snippet: capExcerpt(redact(result.snippet)) }));
  parentPort.postMessage({ results });
} catch { parentPort.postMessage({ error: true }); }
