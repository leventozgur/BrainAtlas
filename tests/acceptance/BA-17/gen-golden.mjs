// SPDX-License-Identifier: MIT
// Regenerates fixtures/golden-search.json from the checkout selected by BA17_ROOT (run it against main, not the
// worktree). Prints only counts, never page bodies.
import fs from 'node:fs';
import { corpusPages, queries, budgets, thresholds } from './corpus.mjs';
import { NOW, goldenFile, loadRetrieval } from './support.mjs';

const { buildIndex: build, search: run } = await loadRetrieval();
const index = build(corpusPages(), { now: NOW });
const entries = [];
for (const q of queries) for (const budgetChars of budgets) for (const abstainThreshold of thresholds) {
  const options = { limit: 5, abstainThreshold, asOf: NOW, ...(budgetChars === undefined ? {} : { budgetChars }) };
  entries.push({ q, budgetChars: budgetChars ?? null, abstainThreshold, out: run(index, q, options) });
}
fs.writeFileSync(goldenFile, `${JSON.stringify({ generatedFrom: 'checkout-under-BA17_ROOT', count: entries.length, entries }, null, 1)}\n`);
console.log(`golden entries: ${entries.length}`);
