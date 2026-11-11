// SPDX-License-Identifier: MIT
// BA-19 retest (independent): file names with spaces, parentheses, tabs and other control characters on a fresh index.
// Checked with the independent reader; three runs must be idempotent. Real stdio MCP server, temporary vault.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { call, okJson, readIndex, readOrNull, startServer } from './harness.mjs';
import { readLinks, linkedPages } from './retest-reader.mjs';

const page = (title) => `---\ntitle: ${title}\n---\nKısa gövde.\n`;

/** Three runs of wiki_update_index: the first adds `added` lines, runs two and three add nothing and keep the bytes. */
async function assertThreeRuns(f, indexed, added) {
  assert.deepEqual(okJson(await call(f.client, 'wiki_update_index', {})), { indexed, added, removed: 0 }, 'run 1');
  const afterFirst = await readIndex(f);
  for (const run of [2, 3]) {
    assert.deepEqual(okJson(await call(f.client, 'wiki_update_index', {})), { indexed, added: 0, removed: 0 }, `run ${run} adds nothing`);
    assert.deepEqual(await readIndex(f), afterFirst, `run ${run} keeps the bytes`);
  }
  return afterFirst.toString('utf8');
}

test('spaced names on a fresh index: angle-bracket destinations, root page under ## Pages, three runs idempotent, coverage 100', async (t) => {
  const files = { 'entities/ali yilmaz.md': page('Ali Yılmaz'), 'root note.md': page('Kök not') };
  const f = await startServer(t, { files });
  const text = await assertThreeRuns(f, 2, 2);
  assert.ok(text.includes('](<entities/ali yilmaz.md>)'), 'folder page uses an angle-bracket destination');
  assert.ok(text.includes('](<root note.md>)'), 'root page uses an angle-bracket destination');
  assert.deepEqual(readLinks(text).map((x) => x.dest).sort(), Object.keys(files).sort(), 'the independent reader reads each name back exactly');
  assert.equal(okJson(await call(f.client, 'wiki_status', {})).indexCoveragePct, 100);
});

test('parentheses inside an angle-bracket destination are escaped; the name reads back unescaped; three runs idempotent', async (t) => {
  const f = await startServer(t, { files: { 'entities/a b(c).md': page('Parantezli boşluk') } });
  const text = await assertThreeRuns(f, 1, 1);
  assert.ok(text.includes('](<entities/a b\\(c\\).md>)'), 'the parentheses are backslash-escaped inside the angle brackets');
  assert.deepEqual(readLinks(text).map((x) => x.dest), ['entities/a b(c).md']);
  assert.equal(okJson(await call(f.client, 'wiki_status', {})).indexCoveragePct, 100);
});

test('a tab in the file name: written inside angle brackets, reads back with the tab, three runs idempotent, coverage 100', async (t) => {
  const name = 'entities/tab\tname.md';
  const f = await startServer(t, { files: { [name]: page('Sekmeli ad') } });
  const text = await assertThreeRuns(f, 1, 1);
  assert.ok(text.includes('](<entities/tab\tname.md>)'), 'the tab is kept inside the angle brackets');
  assert.deepEqual([...linkedPages(text)], [name], 'the independent reader finds the page with its tab');
  assert.equal(okJson(await call(f.client, 'wiki_status', {})).indexCoveragePct, 100);
});

test('a control character (U+0001) in the file name: angle-bracket destination, reads back exactly, three runs idempotent', async (t) => {
  const name = 'entities/ctl\u0001name.md';
  const f = await startServer(t, { files: { [name]: page('Kontrol karakteri') } });
  const text = await assertThreeRuns(f, 1, 1);
  assert.deepEqual([...linkedPages(text)], [name]);
  assert.equal(okJson(await call(f.client, 'wiki_status', {})).indexCoveragePct, 100);
});

test('a line feed in the file name cannot be a CommonMark destination: the server refuses, or the index keeps one valid, idempotent entry', async (t) => {
  const name = 'entities/nl\nname.md';
  const f = await startServer(t, { files: { [name]: page('Satır sonu') } });
  const r = await call(f.client, 'wiki_update_index', {});
  if (r.isError) {
    assert.equal(await readOrNull(join(f.wiki, 'index.md')), null, 'a refused run writes no index');
    return;
  }
  const text = await assertThreeRuns(f, 1, 1);
  assert.deepEqual(readLinks(text).map((x) => x.dest), [name], 'the index holds exactly one readable entry for the page');
});
