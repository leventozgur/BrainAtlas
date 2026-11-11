// SPDX-License-Identifier: MIT
// BA-09 re-test (2026-11-11), added by the second tester. Covers the two code fixes: unquoted impossible dates and offset
// timestamps are neutral, unquoted valid leap/end-of-month dates are verified; a link-added neighbour carries its own trust
// factor (link value = 0.5 x source score x neighbour factor) and the first-result rule still holds.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { loadCandidate, makeVault, removeDir, page, record, NOW } from './helpers.mjs';

const rt = await loadCandidate();
const dirs = [];
after(() => dirs.forEach(removeDir));
const QUERY = 'zephyr quorum ledger';
const BODY = 'zephyr quorum ledger reconciliation notes.';
const confirmed = (date) => `status: confirmed\n${record({ date })}`;
const trustOf = (dir) => Object.fromEntries(rt.buildIndex(rt.loadPages(dir), { now: NOW }).docs.map((d) => [d.page.path, d.trust]));

test('unquoted impossible dates and times are neutral; unquoted valid end-of-month and leap dates are verified', () => {
  const cases = {
    'imp-feb30.md': ['2026-02-30', 'neutral'],
    'imp-feb29.md': ['2026-02-29', 'neutral'],
    'imp-nov31.md': ['2026-11-31', 'neutral'],
    'imp-hour25.md': ['2026-11-01T25:00:00Z', 'neutral'],
    'imp-offset.md': ['2026-11-01T10:30:00+03:00', 'neutral'],
    'ok-feb28.md': ['2026-02-28', 'verified'],
    'ok-leap.md': ['2024-02-29', 'verified'],
    'ok-stamp.md': ['2026-11-01T10:30:00Z', 'verified'],
  };
  const dir = makeVault(Object.fromEntries(Object.entries(cases).map(([f, [d]]) => [f, page({ fm: confirmed(d), body: BODY })])), 'ba09-re-dates-');
  dirs.push(dir);
  const trust = trustOf(dir);
  for (const [file, [date, want]] of Object.entries(cases)) assert.equal(trust[file], want, `${file} (${date})`);
});

test('a neutral top page keeps first place; a link-added verified neighbour scores 0.5 x source x 1.5 and a weak one 0.5 x source x 0.9', () => {
  for (const [label, fm, factor] of [['verified', confirmed('2026-11-01'), 1.5], ['weak', 'status: proposed\n', 0.9], ['neutral', '', 1]]) {
    const dir = makeVault({
      'top.md': page({ title: 'Top', body: `${BODY} See [[nb]].` }),
      'nb.md': page({ title: 'Neighbour', fm, body: 'unrelated lamp wick schedule.' }),
    }, `ba09-re-link-${label}-`);
    dirs.push(dir);
    const out = rt.search(rt.buildIndex(rt.loadPages(dir), { now: NOW }), QUERY, { limit: 10, abstainThreshold: 0.35, asOf: NOW });
    assert.equal(out.results[0].path, 'top.md', `${label}: first result unchanged`);
    assert.equal(Object.hasOwn(out.results[0], 'via'), false, `${label}: first result is lexical`);
    const nb = out.results.find((r) => r.path === 'nb.md');
    assert.ok(nb, `${label}: neighbour returned`);
    assert.equal(nb.via, 'link', `${label}: via link`);
    const s = out.results[0].score;
    assert.ok(Math.abs(nb.score - 0.5 * s * factor) < 1e-12, `${label}: ${nb.score} vs ${0.5 * s * factor}`);
    assert.ok(nb.score < s, `${label}: neighbour below first`);
  }
});

test('a verified source passes its trust-adjusted score to a neutral neighbour: 0.5 x (1.5 x lexical) x 1', () => {
  const dir = makeVault({
    'top.md': page({ title: 'Top', fm: confirmed('2026-11-01'), body: `${BODY} See [[nb]].` }),
    'nb.md': page({ title: 'Neighbour', body: 'unrelated lamp wick schedule.' }),
  }, 'ba09-re-src-');
  dirs.push(dir);
  const out = rt.search(rt.buildIndex(rt.loadPages(dir), { now: NOW }), QUERY, { limit: 10, abstainThreshold: 0.35, asOf: NOW });
  assert.equal(out.results[0].path, 'top.md');
  const top = out.results[0].score;
  const nb = out.results.find((r) => r.path === 'nb.md');
  assert.ok(Math.abs(nb.score - 0.5 * top) < 1e-12, `neutral neighbour = 0.5 x verified top (${nb.score} vs ${0.5 * top})`);
  assert.equal(Object.hasOwn(nb, 'trust'), false);
});
