// SPDX-License-Identifier: MIT
// BA-19 retest (independent): fragment (#x) and query (?v=1) handling in wiki_update_index and wiki_create_*, anchor-only
// and external entries kept byte for byte. Real stdio MCP server, temporary vault, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { call, okJson, readIndex, startServer, sectionLines } from './harness.mjs';
import { linkedPages, readLinks } from './retest-reader.mjs';

const page = (title) => `---\ntitle: ${title}\n---\nKısa gövde.\n`;

test('anchor-only, external and scheme-relative entries are kept byte for byte and are not pages; anchored entry counts once', async (t) => {
  const index = [
    '# Wiki Index', '', '## entities', '',
    '- [Yerel çapa](#ozet) — yalnız çapa',
    '- [Dış](https://example.com/a.md) — harici',
    '- [Protokolsüz](//cdn.example.com/b.md)',
    '- [Posta](mailto:ornek@example.com)',
    '- [Ali](entities/ali.md#ozet) — bölüm', ''
  ].join('\n');
  const f = await startServer(t, { files: { 'index.md': index, 'entities/ali.md': page('Ali') } });
  const before = await readIndex(f);
  assert.deepEqual(okJson(await call(f.client, 'wiki_update_index', {})), { indexed: 1, added: 0, removed: 0 });
  assert.deepEqual(await readIndex(f), before, 'no line was added, removed or rewritten');
  const status = okJson(await call(f.client, 'wiki_status', {}));
  assert.equal(status.pageCount, 1);
  assert.equal(status.indexCoveragePct, 100);
});

test('stale entries with a fragment, a query, or an angle-bracket destination are removed; the live page keeps one entry; a second run is a no-op', async (t) => {
  const index = '# Wiki Index\n\n## entities\n\n- [S1](entities/gone.md#x) — eski\n- [S2](entities/gone2.md?v=2)\n- [S3](<entities/gone 3.md#y>)\n- [Ali](entities/ali.md?v=1#ozet) — canlı\n';
  const f = await startServer(t, { files: { 'index.md': index, 'entities/ali.md': page('Ali') } });
  assert.deepEqual(okJson(await call(f.client, 'wiki_update_index', {})), { indexed: 1, added: 0, removed: 3 }, 'three stale entries are removed');
  assert.equal((await readIndex(f)).toString('utf8'), '# Wiki Index\n\n## entities\n\n- [Ali](entities/ali.md?v=1#ozet) — canlı\n');
  assert.deepEqual(okJson(await call(f.client, 'wiki_update_index', {})), { indexed: 1, added: 0, removed: 0 });
});

test('a salt-only line in a category keeps its bytes; a new page goes into its own folder category and no other', async (t) => {
  const index = '# Wiki Index\n\n## entities\n\n- [Yerel](#ozet)\n\n## concepts\n\n- [K](concepts/k.md)\n';
  const f = await startServer(t, { files: { 'index.md': index, 'entities/ali.md': page('Ali'), 'concepts/k.md': page('K') } });
  assert.deepEqual(okJson(await call(f.client, 'wiki_update_index', {})), { indexed: 2, added: 1, removed: 0 });
  const text = (await readIndex(f)).toString('utf8');
  assert.ok(text.split('\n').includes('- [Yerel](#ozet)'), 'the salt-only line is kept as it was');
  assert.ok(sectionLines(text, 'entities').includes('- [Ali](entities/ali.md)'), 'the new page is under ## entities');
  assert.ok(!sectionLines(text, 'concepts').includes('- [Ali](entities/ali.md)'), 'the new page is not under ## concepts');
  assert.deepEqual(okJson(await call(f.client, 'wiki_update_index', {})), { indexed: 2, added: 0, removed: 0 });
});

test('angle-bracket destination with a fragment to a spaced page counts as linked: no duplicate, coverage 100', async (t) => {
  const index = '# Wiki Index\n\n## entities\n\n- [Ali](<entities/ali yilmaz.md#ozet>)\n';
  const f = await startServer(t, { files: { 'index.md': index, 'entities/ali yilmaz.md': page('Ali Yılmaz') } });
  const before = await readIndex(f);
  assert.deepEqual(okJson(await call(f.client, 'wiki_update_index', {})), { indexed: 1, added: 0, removed: 0 });
  assert.deepEqual(await readIndex(f), before);
  assert.equal(okJson(await call(f.client, 'wiki_status', {})).indexCoveragePct, 100);
});

test('the same page written with a fragment and as a plain entry is listed once by the reader, and wiki_update_index adds nothing', async (t) => {
  const index = '# Wiki Index\n\n## entities\n\n- [Ali](entities/ali.md#ozet)\n- [Ali](entities/ali.md)\n';
  const f = await startServer(t, { files: { 'index.md': index, 'entities/ali.md': page('Ali') } });
  assert.deepEqual(okJson(await call(f.client, 'wiki_update_index', {})), { indexed: 1, added: 0, removed: 0 });
  assert.equal(readLinks((await readIndex(f)).toString('utf8')).length, 2, 'both lines are kept; none is added');
  assert.deepEqual([...linkedPages((await readIndex(f)).toString('utf8'))], ['entities/ali.md']);
});
