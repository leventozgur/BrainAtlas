// SPDX-License-Identifier: MIT
// BA-04 independent acceptance: date-aware and current-aware section choice for result snippets.
// Hermetic: in-memory pages, fixed as-of date 2026-11-11.
import test from 'node:test';
import assert from 'node:assert/strict';
import { page, run, NOW } from './helpers.mjs';

const top = (pages, query, options) => run(pages, query, options).results[0] ?? null;
const headingOf = (pages, query, options) => top(pages, query, options)?.heading ?? null;

test('ISO dates, with and without time, pick the newest section regardless of file order', () => {
  const body = '# Widget\n## Timeout 2025-01-10\nwidget timeout is 5 seconds\n## Timeout 2025-06-01T12:30Z\nwidget timeout is 9 seconds\n## Timeout 2025-03-20\nwidget timeout is 7 seconds\n';
  const r = top([page('w.md', body)], 'widget timeout');
  assert.equal(r.heading, 'Timeout 2025-06-01T12:30Z');
  assert.match(r.snippet, /^## Timeout 2025-06-01T12:30Z\nwidget timeout is 9 seconds$/);
  assert.equal(r.anchor, 'timeout-2025-06-01t1230z');
  assert.equal(r.headingPath, 'Widget > Timeout 2025-06-01T12:30Z');
});

test('DD.MM.YYYY headings are read day first', () => {
  // 05.03.2026 is 5 March, so 2026-04-01 is newer. A month-first reading would make it 3 May and win.
  assert.equal(headingOf([page('l.md', '## Limit 05.03.2026\nwidget limit is 40\n## Limit 2026-04-01\nwidget limit is 60\n')], 'widget limit'), 'Limit 2026-04-01');
  assert.equal(headingOf([page('l.md', '## Limit 05.03.2026\nwidget limit is 40\n## Limit 2026-02-11\nwidget limit is 60\n')], 'widget limit'), 'Limit 05.03.2026');
});

test('an invalid calendar date counts as no date and is never chosen', () => {
  assert.equal(headingOf([page('l.md', '## Limit 2026-02-30\nwidget limit is 90\n## Limit 2026-01-10\nwidget limit is 40\n')], 'widget limit'), 'Limit 2026-01-10');
  assert.equal(headingOf([page('l.md', '## Limit 31.02.2026\nwidget limit is 90\n## Limit 2026-01-10\nwidget limit is 40\n')], 'widget limit'), 'Limit 2026-01-10');
});

test('a Current state heading wins over a newer dated section, in either file order', () => {
  const current = '## Current state — widget limit 40\nwidget limit is 40\n## 2026-09-01 widget limit change\nwidget limit is 60\n';
  const reversed = '## 2026-09-01 widget limit change\nwidget limit is 60\n## Current state — widget limit 40\nwidget limit is 40\n';
  assert.equal(headingOf([page('c.md', current)], 'widget limit'), 'Current state — widget limit 40');
  assert.equal(headingOf([page('c.md', reversed)], 'widget limit'), 'Current state — widget limit 40');
});

test('the Turkish Güncel durum marker is recognised, case and diacritics folded', () => {
  const tr = '## 2026-09-01 widget limit change\nwidget limit is 60\n## Güncel durum — widget limit 40\nwidget limit is 40\n';
  assert.equal(headingOf([page('g.md', tr)], 'widget limit'), 'Güncel durum — widget limit 40');
  const upper = '## 2026-09-01 widget limit change\nwidget limit is 60\n## GUNCEL DURUM — widget limit 40\nwidget limit is 40\n';
  assert.equal(headingOf([page('g.md', upper)], 'widget limit'), 'GUNCEL DURUM — widget limit 40');
});

test('a section dated after the as-of date is never preferred; the as-of day itself is eligible', () => {
  const body = '## 2027-01-01 widget limit planned\nwidget limit will be 100\n## 2026-03-01 widget limit\nwidget limit is 60\n';
  assert.equal(headingOf([page('f.md', body)], 'widget limit'), '2026-03-01 widget limit');
  const onDay = '## 2026-03-01 widget limit\nwidget limit is 60\n## 2026-11-11 widget limit\nwidget limit is 70\n';
  assert.equal(headingOf([page('f.md', onDay)], 'widget limit'), '2026-11-11 widget limit');
});

test('when only future-dated sections match, the best-scoring section is shown as before', () => {
  const body = '## Plan 2027-01-01\nwidget limit planned\n## Overview\nwidget limit timeout settings\n';
  assert.equal(headingOf([page('f.md', body)], 'widget limit timeout'), 'Overview');
});

test('equal dates: the higher term score wins, then the earlier section', () => {
  const higher = '## Limit 2026-05-01\nwidget limit only\n## Limit 2026-05-01 again\nwidget limit timeout\n';
  assert.equal(headingOf([page('e.md', higher)], 'widget limit timeout'), 'Limit 2026-05-01 again');
  const tie = '## Limit 2026-05-01 first\nwidget limit\n## Limit 2026-05-01 second\nwidget limit\n';
  assert.equal(headingOf([page('e.md', tie)], 'widget limit'), 'Limit 2026-05-01 first');
});

test('a dated section below 0.6 of the best score is not a candidate; at 0.6 or above it is', () => {
  // Terms in the best section: widget, limit, timeout (3 distinct). A dated section with one of them scores 1/3.
  const low = '## Overview\nwidget limit timeout\n## Limit 2026-10-01\nwidget only here\n';
  assert.equal(headingOf([page('s.md', low)], 'widget limit timeout'), 'Overview');
  // Two of three terms scores 2/3, which is at least 0.6 of the best and so eligible; the newer dated section wins.
  const enough = '## Overview\nwidget limit timeout\n## Limit 2026-10-01\nwidget limit here\n';
  assert.equal(headingOf([page('s.md', enough)], 'widget limit timeout'), 'Limit 2026-10-01');
});

test('on a page with several topics, a newer unrelated dated section is not chosen', () => {
  const body = '# Runbook\n## Current state — batch size 120\nbatch size is 120 per cycle\n## 2026-10-30 Harbor body limit\nharbor body limit reached once per cycle\n';
  assert.equal(headingOf([page('r.md', body)], 'batch size cycle'), 'Current state — batch size 120');
});

test('a heading inside a backtick or tilde code fence is not a section', () => {
  const body = '## Limit 2025-01-01\nwidget limit is 5\n```\n## 2026-10-01 widget limit fake\nwidget limit is 99\n```\n';
  assert.equal(headingOf([page('k.md', body)], 'widget limit'), 'Limit 2025-01-01');
  const four = '## Limit 2025-01-01\nwidget limit is 5\n````\n```\n## 2026-10-02 widget limit fake\nwidget limit is 99\n````\n';
  assert.equal(headingOf([page('k.md', four)], 'widget limit'), 'Limit 2025-01-01');
  const tilde = '## Limit 2025-01-01\nwidget limit is 5\n~~~\n## 2026-10-03 widget limit fake\nwidget limit is 99\n~~~\n';
  assert.equal(headingOf([page('k.md', tilde)], 'widget limit'), 'Limit 2025-01-01');
});

test('level 4 headings do not delimit sections, so a dated #### line is not a candidate', () => {
  const body = '## Limit 2026-01-01\nwidget limit is 5\n#### 2026-10-01 widget limit fake\nwidget limit is 99\n';
  assert.equal(headingOf([page('h.md', body)], 'widget limit'), 'Limit 2026-01-01');
});

test('a long multi-section page with nested headings picks the newest eligible section and its path', () => {
  const dates = ['2024-01-01', '2025-07-04', '2026-02-02', '2026-09-30', '2026-12-01', '2023-05-05', '2026-06-15'];
  const parts = ['# Changelog', '## Deploys'];
  for (const d of dates) parts.push(`### Window ${d}`, 'deploy window opens nightly');
  parts.push('## Current notes', 'no marker here');
  const r = top([page('long.md', parts.join('\n') + '\n')], 'deploy window');
  // 2026-12-01 is after asOf and is excluded; 2026-09-30 is the newest eligible date.
  assert.equal(r.heading, 'Window 2026-09-30');
  assert.equal(r.headingPath, 'Changelog > Deploys > Window 2026-09-30');
  assert.equal(r.anchor, 'window-2026-09-30');
});

test('duplicate headings get -1 style anchors, and the chosen duplicate keeps its own anchor', () => {
  const body = '## Window 2026-01-01\nwidget window\n## Window 2026-01-01\nwidget window opens\n';
  const r = top([page('d.md', body)], 'widget window opens');
  assert.equal(r.heading, 'Window 2026-01-01');
  assert.equal(r.anchor, 'window-2026-01-01-1');
});

test('an undated page keeps the best-scoring section, with the first one winning a tie', () => {
  const body = '## Setup\nwidget limit configured\n## Tuning\nwidget limit timeout tuned\n';
  assert.equal(headingOf([page('u.md', body)], 'widget limit timeout'), 'Tuning');
  const tie = '## Alpha\nwidget limit\n## Beta\nwidget limit\n';
  assert.equal(headingOf([page('u.md', tie)], 'widget limit'), 'Alpha');
});

test('a headingless page keeps the trimmed body start with null section fields', () => {
  const r = top([page('plain.md', '\n  widget limit is 40 with no headings  \n')], 'widget limit');
  assert.equal(r.snippet, 'widget limit is 40 with no headings');
  assert.equal(r.heading, null);
  assert.equal(r.anchor, null);
  assert.equal(r.headingPath, null);
});

test('the character budget applies to the whole selected snippet, heading line included', () => {
  const body = '## Limit 2026-01-01\nwidget limit is 40 and more text after it\n';
  const r = run([page('b.md', body)], 'widget limit', { budgetChars: 20 });
  assert.equal(r.truncated, true);
  assert.ok(r.results[0].snippet.length <= 20, `snippet length ${r.results[0].snippet.length}`);
  assert.ok(r.results[0].snippet.endsWith('…'));
});

test('the as-of date is the reference point, not the wall clock', () => {
  const body = '## 2026-10-01 widget limit old\nwidget limit is 1\n## 2026-11-05 widget limit new\nwidget limit is 2\n';
  assert.equal(headingOf([page('a.md', body)], 'widget limit', { asOf: new Date('2026-10-20T00:00:00Z') }), '2026-10-01 widget limit old');
  assert.equal(headingOf([page('a.md', body)], 'widget limit', { asOf: NOW }), '2026-11-05 widget limit new');
});
