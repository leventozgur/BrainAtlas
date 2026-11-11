// SPDX-License-Identifier: MIT
// BA-19 blind acceptance, criterion 2: no index yet -> wiki_update_index and wiki_create_* first write; parentheses,
// categories, idempotence, and whether the product's own tools read the result consistently.
import test from 'node:test';
import assert from 'node:assert/strict';
import { call, okJson, readIndex, startServer, linkDestinations, sectionLines } from './harness.mjs';

const page = (title, extra = '') => `---\ntitle: ${title}\n${extra}---\nKısa gövde.\n`;
const PAREN_FILES = {
  'a(b).md': page('Kök (B) [not]'),
  'a)b.md': page('Kök ) kapalı'),
  'a(b)(c).md': page('Üç [köşeli] (paren)'),
  'root-note.md': page('Kök not'),
  'entities/a(b).md': page('Parantez [1] (x)')
};
// Expected escaped destination for each page (backslash before every parenthesis, CommonMark escape).
const ESCAPED = {
  'a(b).md': 'a\\(b\\).md',
  'a)b.md': 'a\\)b.md',
  'a(b)(c).md': 'a\\(b\\)\\(c\\).md',
  'root-note.md': 'root-note.md',
  'entities/a(b).md': 'entities/a\\(b\\).md'
};

test('fresh index with parenthesis pages: escaped destinations, ## Pages for root pages, folder categories', async (t) => {
  const f = await startServer(t, { files: PAREN_FILES });
  assert.deepEqual(okJson(await call(f.client, 'wiki_update_index', {})), { indexed: 5, added: 5, removed: 0 });
  const text = (await readIndex(f)).toString('utf8');
  for (const [page, dest] of Object.entries(ESCAPED)) {
    assert.ok(text.includes(`](${dest})`), `${page} must be written with escaped destination ${dest}`);
    if (page.includes('(') || page.includes(')')) {
      assert.ok(!text.includes(`](${page})`), `${page} must not appear with an unescaped destination`);
    }
  }
  const rootSection = sectionLines(text, 'Pages');
  assert.ok(rootSection, 'a ## Pages category exists for root pages');
  assert.deepEqual(rootSection.filter((l) => l.startsWith('- [')).length, 4, 'all four root pages are under ## Pages');
  const folderSection = sectionLines(text, 'entities');
  assert.ok(folderSection, 'a folder category exists for entities/');
  assert.equal(folderSection.filter((l) => l.startsWith('- [')).length, 1, 'the entities page is under its folder category');
  assert.equal(text.split('\n').filter((l) => /^## /.test(l)).length, 2, 'exactly two categories: Pages and entities');
});

test('fresh index: an independent CommonMark-style reader finds each page exactly once, and every destination is a page', async (t) => {
  const f = await startServer(t, { files: PAREN_FILES });
  okJson(await call(f.client, 'wiki_update_index', {}));
  const text = (await readIndex(f)).toString('utf8');
  const dests = linkDestinations(text).map((x) => x.dest);
  const pages = Object.keys(PAREN_FILES);
  for (const page of pages) {
    assert.equal(dests.filter((d) => d === page).length, 1, `${page} must be linked exactly once after unescaping`);
  }
  assert.equal(dests.length, pages.length, 'no extra or broken link destinations');
});

test('three consecutive wiki_update_index runs on a fresh index: the first writes, runs two and three add nothing and keep the bytes', async (t) => {
  const f = await startServer(t, { files: PAREN_FILES });
  assert.deepEqual(okJson(await call(f.client, 'wiki_update_index', {})), { indexed: 5, added: 5, removed: 0 });
  const afterFirst = await readIndex(f);
  for (const run of [2, 3]) {
    assert.deepEqual(okJson(await call(f.client, 'wiki_update_index', {})), { indexed: 5, added: 0, removed: 0 }, `run ${run} must add nothing`);
    assert.deepEqual(await readIndex(f), afterFirst, `run ${run} changed the bytes`);
  }
});

test('fresh index written by wiki_create_entity with a parenthesis page present: the new page is escaped and runs stay idempotent', async (t) => {
  const f = await startServer(t, { files: { 'entities/a(b).md': page('Parantez') } });
  okJson(await call(f.client, 'wiki_create_entity', { name: 'Deneme Varlik', content: 'Ev.' }));
  const first = await readIndex(f);
  assert.equal(first.toString('utf8'), '# Wiki Index\n\n## entities\n\n- [Deneme Varlik](entities/deneme-varlik.md)\n', 'the fresh index holds only the created entry');
  assert.deepEqual(okJson(await call(f.client, 'wiki_update_index', {})), { indexed: 2, added: 1, removed: 0 }, 'the existing parenthesis page is added escaped, once');
  const second = await readIndex(f);
  assert.match(second.toString('utf8'), /\]\(entities\/a\\\(b\\\)\.md\)/);
  assert.deepEqual(okJson(await call(f.client, 'wiki_update_index', {})), { indexed: 2, added: 0, removed: 0 });
  assert.deepEqual(await readIndex(f), second);
});

test('product tools read the fresh index consistently: wiki_read_index returns the file, and wiki_status coverage is 100 when every page is listed', async (t) => {
  const f = await startServer(t, { files: PAREN_FILES });
  okJson(await call(f.client, 'wiki_update_index', {}));
  const onDisk = (await readIndex(f)).toString('utf8');
  assert.equal(okJson(await call(f.client, 'wiki_read_index', {})).content, onDisk, 'wiki_read_index returns the same bytes');
  const status = okJson(await call(f.client, 'wiki_status', {}));
  assert.equal(status.pageCount, 5);
  assert.equal(status.indexCoveragePct, 100, 'every page is listed in the index, so coverage must be 100 (wiki_status must read the escaped destinations)');
  assert.deepEqual(okJson(await call(f.client, 'wiki_lint', {})).findings, [], 'lint reports no index finding');
});
