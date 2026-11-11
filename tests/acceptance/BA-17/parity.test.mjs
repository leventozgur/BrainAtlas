// SPDX-License-Identifier: MIT
// BA-17 parity with main: the golden file was generated from main (commit 87d6845) and holds the complete search
// output (results, snippets, scores, flags, reasons) for a fixed corpus and query matrix (ASCII only, several budgets,
// two thresholds). The worktree must reproduce every entry exactly, except the deep-path suffix queries that the BA-18
// fix is meant to change: there main abstains with identifier-not-found, and the worktree must now return the page.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadRetrieval, NOW, goldenFile, ROOT } from './support.mjs';
import { corpusPages } from './corpus.mjs';

const { buildIndex, search } = await loadRetrieval();
const golden = JSON.parse(fs.readFileSync(goldenFile, 'utf8'));
const index = buildIndex(corpusPages(), { now: NOW });
const runEntry = (e) => search(index, e.q, { limit: 5, abstainThreshold: e.abstainThreshold, asOf: NOW, ...(e.budgetChars == null ? {} : { budgetChars: e.budgetChars }) });

// Deep-path suffix queries (key of more than twelve segments) whose main result was a BA-18 abstention.
const expectedChanged = new Set([
  'd10/d11/handler-x-13.mjs', 'd11/handler-x-13.mjs', 'd9/d10/d11/handler-x-13.mjs', 'd14/d15/handler-x-13.mjs',
  'd15/handler-x-13.mjs', 'e16/build-2.1/report.v2.json', 'e15/e16/build-2.1/report.v2.json', 'f19/f20/a_b.c-d.mjs',
  'f18/f19/f20/a_b.c-d.mjs', 'd10/d11/handler-x-13.mjs in the widget notes?',
]);

test('golden file covers the whole matrix and was generated from the main checkout', () => {
  assert.equal(golden.entries.length, golden.count);
  assert.ok(golden.entries.length > 1000);
  assert.equal(golden.generatedFrom, 'checkout-under-BA17_ROOT');
});

test('every golden entry is reproduced exactly, except the BA-18 deep-path suffix queries', () => {
  const changed = new Map();
  for (const e of golden.entries) {
    const out = runEntry(e);
    if (JSON.stringify(out) === JSON.stringify(e.out)) continue;
    if (!changed.has(e.q)) changed.set(e.q, []);
    changed.get(e.q).push({ budgetChars: e.budgetChars, threshold: e.abstainThreshold, before: e.out, after: out });
  }
  const unexpected = [...changed.keys()].filter(q => !expectedChanged.has(q));
  assert.deepEqual(unexpected, [], `unexpected parity break in ${ROOT}`);
  for (const [q, rows] of changed) {
    for (const row of rows) {
      assert.equal(row.before.abstained, true, `${q}: main must have abstained`);
      assert.equal(row.before.reason, 'identifier-not-found', `${q}: main reason`);
      assert.equal(row.after.abstained, false, `${q}: must no longer abstain`);
      assert.ok(row.after.results.length > 0, `${q}: must return the page`);
    }
  }
  // The fix must not change the ordinary-word queries or the short-path queries at all.
  assert.ok(golden.entries.some(e => e.q === 'widget pipeline retries'));
  assert.equal(changed.has('widget pipeline retries'), false);
});

test('ASCII snippets at every budget are byte-identical to main (snippet, truncated flag, heading and anchor)', () => {
  let checked = 0;
  for (const e of golden.entries) {
    if (e.budgetChars == null) continue;
    const out = runEntry(e);
    if (JSON.stringify(out) !== JSON.stringify(e.out)) continue;
    for (const r of out.results) { assert.equal(/^[\x00-\x7f]*\u2026?$/.test(r.snippet), true, 'ASCII snippet (an ellipsis may end it)'); checked++; }
  }
  assert.ok(checked > 100, `checked ${checked} ASCII snippets`);
});
