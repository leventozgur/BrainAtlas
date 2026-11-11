// SPDX-License-Identifier: MIT
// BA-04 holdout measurement (tester-owned): for each current-state case with superseded `excluded` pages, checks whether
// its `relevant` replacement page is in the top 3 results. Usage: node superseded-top3.mjs <repoRoot> <holdoutDir>
// Prints one JSON object with the hit rate and per-case outcome (ids and booleans only; no query text or snippets).
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const [repoRoot, holdoutDir] = process.argv.slice(2);
if (!repoRoot || !holdoutDir) { console.error('usage: superseded-top3.mjs <repoRoot> <holdoutDir>'); process.exit(2); }
const retrieval = await import(pathToFileURL(path.join(path.resolve(repoRoot), 'packages/core/src/retrieval/index.mjs')).href);
const now = new Date('2026-11-11T00:00:00Z');
const cases = JSON.parse(fs.readFileSync(path.join(path.resolve(holdoutDir), 'current-state-cases.json'), 'utf8'))
  .filter(c => Array.isArray(c.excluded) && c.excluded.length > 0);
const index = retrieval.buildIndex(retrieval.loadPages(path.join(path.resolve(holdoutDir), 'corpus')), { now });
const rows = cases.map(c => {
  const res = retrieval.search(index, c.query, { limit: 10, abstainThreshold: 0.35, asOf: now });
  const top3 = res.results.slice(0, 3).map(r => r.path);
  const hit = !res.abstained && c.relevant.some(p => top3.includes(p));
  return { id: c.id, excludedCount: c.excluded.length, hit, rank: c.relevant.map(p => { const i = res.results.findIndex(r => r.path === p); return i < 0 ? null : i + 1; }) };
});
const hits = rows.filter(r => r.hit).length;
console.log(JSON.stringify({ cases: rows.length, hits, rate: rows.length ? hits / rows.length : 0, rows }, null, 2));
