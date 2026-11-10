// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex } from '../../packages/core/src/retrieval/index.mjs';
import { searchHybrid } from '../../modules/semantic/src/hybrid.mjs';

const now = new Date('2025-01-01T00:00:00Z');
const page = (name, title, body, frontmatter = {}) => ({ path: name, title, aliases: [], keywords: [], headings: [], body, frontmatter });
const pages = [
  page('a.md', 'Backup', '# Backup\nbackup routine for the vault', { generated: '2024-01-01', stale_after: 'P7D' }),
  page('b.md', 'Restore', '# Restore\nrestore the backup archive'),
  page('c.md', 'Old', 'backup superseded page', { status: 'superseded' }),
  page('d.md', 'Notes', '# Notes\nunrelated notes about gardens'),
];
const entries = [
  { path: 'a.md', vector: [1, 0], text: 'backup routine', headingPath: 'Backup' },
  { path: 'b.md', vector: [0.8, 0.2], text: 'restore archive', headingPath: 'Restore' },
  { path: 'd.md', vector: [0, 1], text: 'gardens', headingPath: 'Notes' },
];
const provider = { fingerprint: 'fixed', embedQuery: async () => [1, 0] };
const plain = (value) => JSON.parse(JSON.stringify(value));

test('searchHybrid with a supplied lexical index returns the same results as building it from the pages', async () => {
  const lexicalIndex = buildIndex(pages, { now });
  for (const query of ['backup', 'restore the archive', 'gardens', 'unmatched words', 'backup superseded']) {
    for (const mode of ['rrf', 'semantic-primary']) {
      const built = await searchHybrid({ query, pages, entries, provider, asOf: now, mode, limit: 5 });
      const supplied = await searchHybrid({ query, pages, entries, provider, asOf: now, mode, limit: 5, lexicalIndex });
      assert.deepEqual(plain(supplied), plain(built), `${query} / ${mode}`);
      assert.equal(supplied.fallbackReason, built.fallbackReason);
    }
  }
});

test('searchHybrid uses the supplied lexical index and leaves the default path unchanged', async () => {
  const other = buildIndex([page('z.md', 'Zebra', '# Zebra\nzebra only here')], { now });
  const fromOther = await searchHybrid({ query: 'backup', pages, entries: [], provider, asOf: now, lexicalIndex: other });
  assert.deepEqual(fromOther.map((item) => item.path), []);
  const fallback = await searchHybrid({ query: 'backup', pages, entries: [], provider, asOf: now });
  assert.ok(fallback.map((item) => item.path).includes('a.md'));
});
