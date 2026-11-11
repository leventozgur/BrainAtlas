// SPDX-License-Identifier: MIT
// BA-19 retest (independent): wiki_status indexCoveragePct over a mixed vault, the no-index and no-page cases, and a
// wiki/ directory symlinked outside the vault. Real stdio MCP server, temporary vault, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { call, okJson, textOf, startServer, readIndex } from './harness.mjs';
import { linkedPages } from './retest-reader.mjs';

const page = (title) => `---\ntitle: ${title}\n---\nKısa gövde.\n`;
const percent = (covered, total) => Math.round((covered / total) * 100);

// Six pages: four are named by the index (escaped parenthesis, angle-bracket with a space, anchor, query on a nested
// path); two are not (one only inside a fenced block, one not mentioned at all). A stale entry must not count.
const MIXED_PAGES = {
  'a(b).md': page('Kök (B)'),
  'entities/ali yilmaz.md': page('Ali Yılmaz'),
  'concepts/kavram.md': page('Kavram'),
  'entities/deep/nested/n.md': page('İç içe'),
  'root-note.md': page('Kapalı not'),
  'entities/yok-dd.md': page('Elle eklenmemiş')
};
const MIXED_INDEX = [
  '# Wiki Index',
  '',
  '## Pages',
  '',
  '- [Kök (B)](a\\(b\\).md) — kaçışlı',
  '- [Silinmiş](entities/silinmis.md) — eski satır',
  '',
  '## entities',
  '',
  '- [Ali Yılmaz](<entities/ali yilmaz.md>) — açılı',
  '- [İç içe](entities/deep/nested/n.md?v=1) — sorgu',
  '',
  '```',
  '- [Kapalı](root-note.md)',
  '```',
  '',
  '## concepts',
  '',
  '- [Kavram](concepts/kavram.md#ozet) — çapa',
  ''
].join('\n');

test('mixed vault: coverage is the rounded share of pages named by an escaped, angle-bracket, anchored, query or nested entry; fenced and stale entries do not count', async (t) => {
  const f = await startServer(t, { files: { ...MIXED_PAGES, 'index.md': MIXED_INDEX } });
  const independent = Object.keys(MIXED_PAGES).filter((p) => linkedPages(MIXED_INDEX).has(p));
  assert.equal(independent.length, 4, 'fixture self-check: the independent reader links exactly four pages');
  const status = okJson(await call(f.client, 'wiki_status', {}));
  assert.equal(status.pageCount, 6, 'index.md and log.md are not counted as pages');
  assert.equal(status.indexCoveragePct, percent(4, 6), 'four of six pages, rounded: 67');
});

test('fresh index with unbalanced and nested parenthesis names: coverage is 100 after wiki_update_index', async (t) => {
  const f = await startServer(t, { files: { 'a)b.md': page('Kapanmamış'), 'a(b)(c).md': page('İki çift'), 'entities/x(1).md': page('Bir') } });
  okJson(await call(f.client, 'wiki_update_index', {}));
  const text = (await readIndex(f)).toString('utf8');
  assert.deepEqual([...linkedPages(text)].sort(), ['a(b)(c).md', 'a)b.md', 'entities/x(1).md'], 'the independent reader finds every page');
  assert.equal(okJson(await call(f.client, 'wiki_status', {})).indexCoveragePct, 100);
});

test('no index file: coverage is 0 while pages exist', async (t) => {
  const f = await startServer(t, { files: { 'entities/ali.md': page('Ali'), 'root.md': page('Kök') } });
  const status = okJson(await call(f.client, 'wiki_status', {}));
  assert.equal(status.pageCount, 2);
  assert.equal(status.indexCoveragePct, 0);
  assert.equal(status.indexAgeMs, null, 'no index means no index age');
});

test('no pages and no index: coverage is 100', async (t) => {
  const f = await startServer(t, {});
  const status = okJson(await call(f.client, 'wiki_status', {}));
  assert.equal(status.pageCount, 0);
  assert.equal(status.indexCoveragePct, 100);
});

test('no pages but an index that lists missing pages: coverage is still 100 (there are no pages to cover)', async (t) => {
  const f = await startServer(t, { files: { 'index.md': '# Wiki Index\n\n## entities\n\n- [Yok](entities/yok.md)\n' } });
  const status = okJson(await call(f.client, 'wiki_status', {}));
  assert.equal(status.pageCount, 0);
  assert.equal(status.indexCoveragePct, 100);
});

test('wiki/ symlinked outside the vault: wiki_status answers as an empty Wiki and returns no outside title, path or index content', async (t) => {
  const f = await startServer(t, { wikiLink: {
    'index.md': '# Wiki Index\n\n## entities\n\n- [Dış](entities/dis.md)\n',
    'entities/dis.md': page('DIS-SAYFA-ISARETI')
  } });
  const r = await call(f.client, 'wiki_status', {});
  const status = okJson(r);
  const text = textOf(r);
  assert.equal(status.pageCount, 0, 'outside pages are not counted');
  assert.equal(status.okfWarningCount, 0);
  assert.equal(status.okfErrorCount, 0);
  assert.equal(status.indexAgeMs, null, 'the outside index is not stat-ed for its age');
  assert.equal(typeof status.readOnly, 'boolean');
  assert.ok(!text.includes('DIS-SAYFA-ISARETI') && !text.includes('dis.md'), 'no outside page title or path is returned');
  assert.ok(!text.includes('outside-wiki') && !text.includes(f.dir), 'no outside directory or temporary path is returned');
});

// Contract (docs/contracts/mcp-tools.md, wiki_status): "100 when there are no pages". The escaped view is documented as
// "answer as an empty Wiki", so the same rule applies. The product returns null here (see the source line of the view).
test('wiki/ symlinked outside the vault: indexCoveragePct follows the empty-Wiki rule (100), not null', async (t) => {
  const f = await startServer(t, { wikiLink: { 'entities/dis.md': page('Dış') } });
  assert.equal(okJson(await call(f.client, 'wiki_status', {})).indexCoveragePct, 100);
});
