// SPDX-License-Identifier: MIT
// BA-19 final verification (independent, blind): a page whose path holds CR, U+0085, U+2028 or U+2029 is never written
// to the index and is not counted by wiki_status coverage; the other pages are still indexed; three runs are idempotent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { call, okJson, startServer, readIndex, singleInsertion } from './harness.mjs';
import { linkedPages } from './retest-reader.mjs';

const page = (title) => `---\ntitle: ${title}\n---\nKısa gövde.\n`;
const LINE_BREAKS = [
  ['CR', '\r'],
  ['U+0085 NEL', '\u0085'],
  ['U+2028 LINE SEPARATOR', ' '],
  ['U+2029 PARAGRAPH SEPARATOR', ' ']
];
const OK_PAGES = {
  'entities/ok-a.md': page('Tamam A'),
  'concepts/ok-b.md': page('Tamam B'),
  'root-ok.md': page('Kök Tamam')
};
const badName = (ch) => `entities/bad${ch}gizli.md`;

for (const [label, ch] of LINE_BREAKS) {
  test(`${label} in a page name: the page is left out of a fresh index, the other pages are indexed, three runs are idempotent`, async (t) => {
    const f = await startServer(t, { files: { ...OK_PAGES, [badName(ch)]: page('GIZLI-BASLIK') } });
    const first = okJson(await call(f.client, 'wiki_update_index', {}));
    const bytes1 = await readIndex(f);
    const text = bytes1.toString('utf8');
    assert.equal(first.added, 3, 'only the three countable pages gain an entry');
    assert.equal(first.indexed, 4, 'the page on disk is still counted as a page');
    assert.ok(!text.includes(ch), `no index byte is the line-breaking character U+${ch.codePointAt(0).toString(16).padStart(4, '0')}`);
    assert.ok(!text.includes('gizli') && !text.includes('GIZLI'), 'neither the name nor the title of the excluded page is in the index');
    assert.deepEqual([...linkedPages(text)].sort(), ['concepts/ok-b.md', 'entities/ok-a.md', 'root-ok.md']);
    for (let run = 2; run <= 3; run++) {
      const again = okJson(await call(f.client, 'wiki_update_index', {}));
      assert.equal(again.added, 0, `run ${run} adds nothing`);
      assert.deepEqual(await readIndex(f), bytes1, `run ${run} keeps the bytes`);
    }
  });

  test(`${label} in a page name: a hand-edited index keeps its own bytes and gains only the countable pages`, async (t) => {
    const hand = '# Wiki Index\n\nElle yazılmış not, kapanış yok.\n\n## entities\n\n- [Tamam A](entities/ok-a.md) — özet #etiket\n';
    const f = await startServer(t, { files: { ...OK_PAGES, [badName(ch)]: page('GIZLI-BASLIK'), 'index.md': hand } });
    const result = okJson(await call(f.client, 'wiki_update_index', {}));
    const after = await readIndex(f);
    const afterText = after.toString('utf8');
    assert.equal(result.added, 2, 'concepts/ok-b.md and root-ok.md gain a line; the excluded page does not');
    assert.equal(result.removed, 0);
    assert.ok(!afterText.includes(ch), 'no line-breaking character in the index');
    assert.ok(afterText.startsWith(hand), 'the hand-written bytes are a prefix of the new index (new categories are appended)');
    const bytes1 = after;
    const second = okJson(await call(f.client, 'wiki_update_index', {}));
    assert.equal(second.added, 0);
    assert.deepEqual(await readIndex(f), bytes1);
    const third = okJson(await call(f.client, 'wiki_update_index', {}));
    assert.equal(third.added, 0);
    assert.deepEqual(await readIndex(f), bytes1);
  });
}

test('one bad name among many ordinary pages does not block the others (all countable pages are linked)', async (t) => {
  const files = {};
  for (let i = 0; i < 12; i++) files[`entities/normal-${String(i).padStart(2, '0')}.md`] = page(`Normal ${i}`);
  for (const [, ch] of LINE_BREAKS) files[badName(ch)] = page('GIZLI');
  const f = await startServer(t, { files });
  const result = okJson(await call(f.client, 'wiki_update_index', {}));
  assert.equal(result.added, 12);
  const linked = linkedPages((await readIndex(f)).toString('utf8'));
  for (let i = 0; i < 12; i++) assert.ok(linked.has(`entities/normal-${String(i).padStart(2, '0')}.md`), `normal-${i} is linked`);
  assert.equal(linked.size, 12);
});

test('wiki_status coverage uses only countable pages as the denominator: 2 of 3 countable pages listed, four excluded pages do not dilute it', async (t) => {
  const files = { ...OK_PAGES };
  for (const [, ch] of LINE_BREAKS) files[badName(ch)] = page('GIZLI');
  files['index.md'] = '# Wiki Index\n\n## entities\n\n- [Tamam A](entities/ok-a.md)\n\n## concepts\n\n- [Tamam B](concepts/ok-b.md)\n';
  const f = await startServer(t, { files });
  const status = okJson(await call(f.client, 'wiki_status', {}));
  assert.equal(status.pageCount, 7, 'excluded pages stay in pageCount (3 countable + 4 excluded)');
  assert.equal(status.indexCoveragePct, 67, 'two of three countable pages, rounded: 67 (not 2/7 = 29)');
});

test('wiki_status coverage is 100 when every countable page is listed, even with excluded pages present', async (t) => {
  const files = { ...OK_PAGES };
  for (const [, ch] of LINE_BREAKS) files[badName(ch)] = page('GIZLI');
  const f = await startServer(t, { files });
  okJson(await call(f.client, 'wiki_update_index', {}));
  assert.equal(okJson(await call(f.client, 'wiki_status', {})).indexCoveragePct, 100);
});

test('only excluded pages on disk: no countable page, so coverage is 100 (empty-Wiki rule), and the index has no entry', async (t) => {
  const files = {};
  for (const [, ch] of LINE_BREAKS) files[badName(ch)] = page('GIZLI');
  const f = await startServer(t, { files });
  const status = okJson(await call(f.client, 'wiki_status', {}));
  assert.equal(status.pageCount, 4);
  assert.equal(status.indexCoveragePct, 100);
  const result = okJson(await call(f.client, 'wiki_update_index', {}));
  assert.equal(result.added, 0);
  const text = (await readIndex(f)).toString('utf8');
  assert.ok(!/- \[/.test(text), 'no entry line is written');
});

test('an excluded page does not stop a later create: the new ordinary page is added as one line, the excluded page stays out', async (t) => {
  const f = await startServer(t, { files: { ...OK_PAGES, [badName(' ')]: page('GIZLI') } });
  const seed = okJson(await call(f.client, 'wiki_update_index', {}));
  assert.equal(seed.added, 3);
  const before = await readIndex(f);
  const created = okJson(await call(f.client, 'wiki_create_entity', { name: 'Yeni Kayit', content: 'Gövde.\n' }));
  assert.equal(created.path, 'wiki/entities/yeni-kayit.md');
  const after = await readIndex(f);
  const inserted = singleInsertion(before, after);
  assert.ok(inserted.line.includes('entities/yeni-kayit.md'), 'the single new line is the new page');
  assert.ok(!after.toString('utf8').includes(' ') && !after.toString('utf8').includes('gizli'));
});

test('an existing hand-written line for an excluded page (U+2028 in the name) is kept byte for byte by index runs and creates', async (t) => {
  const hand = `# Wiki Index\n\n## entities\n\n- [Elle gizli](entities/bad gizli.md) — elle yazılmış\n- [Tamam A](entities/ok-a.md)\n`;
  const f = await startServer(t, { files: { ...OK_PAGES, [badName(' ')]: page('GIZLI'), 'index.md': hand } });
  const result = okJson(await call(f.client, 'wiki_update_index', {}));
  assert.equal(result.removed, 0, 'the line is for a page that exists, so it is not stale');
  const afterIndex = await readIndex(f);
  assert.ok(afterIndex.toString('utf8').startsWith(hand), 'the hand-written lines are kept as they were');
  okJson(await call(f.client, 'wiki_create_entity', { name: 'Yeni Kayit', content: 'Gövde.\n' }));
  const afterCreate = await readIndex(f);
  assert.ok(afterCreate.toString('utf8').startsWith(hand), 'a create keeps the hand-written lines too');
  const status = okJson(await call(f.client, 'wiki_status', {}));
  assert.equal(status.indexCoveragePct, 100, 'countable pages (ok-a, ok-b, root-ok, yeni-kayit) are all listed');
});
