// SPDX-License-Identifier: MIT
// BA-24 B4: the semantic hybrid uses the core `stale()` rule (one implementation), so both paths flag the same pages.
// Covers an ISO date, a P<n>D / P<n>W duration from `generated`, a Date value, a past and a future expiry, and an invalid
// value. No network, no files.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex, search, stale } from '../../packages/core/src/retrieval/index.mjs';
import { searchHybrid } from '../../modules/semantic/src/hybrid.mjs';

const now = new Date('2026-06-01T00:00:00Z');
const cases = {
  pastDate: { generated: '2026-01-01', stale_after: '2026-02-01' },
  futureDate: { generated: '2026-01-01', stale_after: '2027-02-01' },
  dateValue: { generated: new Date('2026-01-01T00:00:00Z'), stale_after: new Date('2026-02-01T00:00:00Z') },
  durationDays: { generated: '2026-05-01', stale_after: 'P7D' },
  durationWeeks: { generated: '2026-05-01', stale_after: 'P2W' },
  durationFuture: { generated: '2026-05-30', stale_after: 'P60D' },
  invalid: { generated: '2026-01-01', stale_after: 'soon' },
  absent: { generated: '2026-01-01' },
};

test('core stale() gives the expected flags for each expiry form', () => {
  assert.equal(stale(cases.pastDate, now), true);
  assert.equal(stale(cases.futureDate, now), false);
  assert.equal(stale(cases.dateValue, now), true);
  assert.equal(stale(cases.durationDays, now), true);
  assert.equal(stale(cases.durationWeeks, now), true);
  assert.equal(stale(cases.durationFuture, now), false);
  assert.equal(stale(cases.invalid, now), false);
  assert.equal(stale(cases.absent, now), false);
});

test('semantic hybrid reports the same stale flag as the core search for every case', async () => {
  const pages = Object.entries(cases).map(([name, frontmatter]) => ({
    path: `${name}.md`,
    title: name,
    aliases: [],
    keywords: [],
    headings: [],
    body: `# ${name}\nshared marker words`,
    frontmatter,
  }));
  const entries = pages.map((page) => ({ path: page.path, vector: [1, 0], text: page.body, headingPath: page.title }));
  const provider = { fingerprint: 'fixed', embedQuery: async () => [1, 0] };
  const index = buildIndex(pages, { now });
  const core = new Map(search(index, 'marker', { limit: 20, asOf: now }).results.map((row) => [row.path, row.stale]));
  const hybrid = await searchHybrid({
    query: 'marker',
    pages,
    entries,
    provider,
    asOf: now,
    mode: 'rrf',
    limit: 20,
    lexicalIndex: index,
  });
  assert.ok(hybrid.length > 0);
  for (const item of hybrid) assert.equal(item.stale, core.get(item.path), item.path);
  assert.equal(hybrid.find((item) => item.path === 'pastDate.md').stale, true);
  assert.equal(hybrid.find((item) => item.path === 'durationFuture.md').stale, false);
});
