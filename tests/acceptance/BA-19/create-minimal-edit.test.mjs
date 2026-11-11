// SPDX-License-Identifier: MIT
// BA-19 blind acceptance, criterion 1: wiki_create_entity / wiki_create_concept on a hand-edited index, over stdio MCP.
import test from 'node:test';
import assert from 'node:assert/strict';
import { call, okJson, refused, readIndex, snapshot, singleInsertion, startServer, sectionLines, SECRET_OPENAI, SECRET_GITHUB } from './harness.mjs';

const page = (title, extra = '') => `---\ntitle: ${title}\n${extra}---\nKısa gövde.\n`;

// Hand-edited index: emoji and Turkish prose, a preface, a fenced block that imitates a heading and an entry, a
// hand-written paragraph inside a category, a blockquote, and a second category.
const HAND_LF = [
  '# Wiki İndeksi 📚',
  '',
  'Önsöz: bu indeks elle düzenlendi 🙂 — notlar, [köşeli] ve (parantezli) metin.',
  '',
  '```',
  '- [Kod örneği](entities/kod-ornegi.md)',
  '## Entities (kod içi, başlık sayılmamalı)',
  '```',
  '',
  '## Entities',
  '',
  '- [Ali Yılmaz](entities/ali-yilmaz.md) — Türkçe özet 🚀 #kişi',
  'Bu paragraf elle yazıldı; satır bozulmamalı.',
  '',
  '> Alıntı notu: karar 2026-01-01.',
  '',
  '## Concepts',
  '',
  '- [Kavram](concepts/kavram.md) — not 📝',
  '',
  'Son paragraf.',
  ''
].join('\n');

const FILES_LF = {
  'index.md': HAND_LF,
  'entities/ali-yilmaz.md': page('Ali Yılmaz'),
  'entities/kod-ornegi.md': page('Kod örneği'),
  'concepts/kavram.md': page('Kavram')
};

test('create entity on a hand-edited LF index: exactly one line is added, under ## Entities, every other byte is kept', async (t) => {
  const f = await startServer(t, { files: FILES_LF });
  const before = await readIndex(f);
  const created = okJson(await call(f.client, 'wiki_create_entity', { name: 'Deneme Varlik', content: 'Ev.' }));
  assert.deepEqual(created, { path: 'wiki/entities/deneme-varlik.md', created: true });
  const after = await readIndex(f);
  const { at, line } = singleInsertion(before, after);
  assert.equal(line, '- [Deneme Varlik](entities/deneme-varlik.md)');
  const lines = after.toString('utf8').split('\n');
  assert.equal(lines[at - 1], '- [Ali Yılmaz](entities/ali-yilmaz.md) — Türkçe özet 🚀 #kişi', 'the new line follows the last entry of ## Entities');
  assert.equal(lines[at + 1], 'Bu paragraf elle yazıldı; satır bozulmamalı.', 'the hand-written paragraph after it is untouched');
  assert.ok(sectionLines(after.toString('utf8'), 'entities').includes(line), 'the line sits in the Entities section');
  assert.ok(!sectionLines(after.toString('utf8'), 'concepts').includes(line), 'the line is not in the Concepts section');
});

test('create entity on a hand-edited CRLF index: one CRLF line is added in the category, all other lines keep their bytes', async (t) => {
  const crlf = [
    '# Wiki Index',
    '',
    'Notlar: CRLF dosyası 🧪 — elle yazıldı.',
    '',
    '## concepts',
    '',
    '- [Kavram](concepts/kavram.md) — açıklama #etiket',
    '  devam satırı, girintili',
    '',
    '## Entities',
    '',
    '- [Ali Yılmaz](entities/ali-yilmaz.md)',
    ''
  ].join('\r\n');
  const f = await startServer(t, { files: { 'index.md': crlf, 'entities/ali-yilmaz.md': page('Ali Yılmaz'), 'concepts/kavram.md': page('Kavram') } });
  const before = await readIndex(f);
  assert.equal(before.toString('utf8'), crlf, 'fixture is written as given');
  okJson(await call(f.client, 'wiki_create_concept', { name: 'Yeni Kavram', content: 'Kavram.' }));
  const after = await readIndex(f);
  const { at, line } = singleInsertion(before, after);
  assert.equal(line, '- [Yeni Kavram](concepts/yeni-kavram.md)\r', 'the inserted line uses the file CRLF style');
  const lines = after.toString('utf8').split('\n');
  // Contract: the line goes after the last entry of its category (the continuation line is not an entry).
  assert.equal(lines[at - 1], '- [Kavram](concepts/kavram.md) — açıklama #etiket\r', 'the inserted line follows the last entry of ## concepts');
  assert.equal(lines[at + 1], '  devam satırı, girintili\r', 'the continuation line that followed the entry is kept byte for byte');
});

test('create concept when the index has no category for it: the category is appended and the old bytes stay a prefix', async (t) => {
  const index = '# Wiki Index\n\n## entities\n\n- [Ali](entities/ali.md) — kayıt\n';
  const f = await startServer(t, { files: { 'index.md': index, 'entities/ali.md': page('Ali') } });
  okJson(await call(f.client, 'wiki_create_concept', { name: 'Yeni Kavram', content: 'K.' }));
  const after = (await readIndex(f)).toString('utf8');
  assert.ok(after.startsWith(index), 'every original byte is kept as a prefix');
  assert.match(after.slice(index.length), /^\n## concepts\n\n- \[Yeni Kavram\]\(concepts\/yeni-kavram\.md\)\n$/, 'only the new category block is appended');
});

test('create entity twice: the second call is refused with E_ALREADY_EXISTS and the whole Wiki tree is unchanged', async (t) => {
  const f = await startServer(t, { files: FILES_LF });
  okJson(await call(f.client, 'wiki_create_entity', { name: 'Deneme Varlik', content: 'Ev.' }));
  okJson(await call(f.client, 'wiki_create_concept', { name: 'Deneme Kavram', content: 'Kavram.' }));
  const before = await snapshot(f.wiki);
  refused(await call(f.client, 'wiki_create_entity', { name: 'Deneme Varlik', content: 'Başka içerik.' }), 'E_ALREADY_EXISTS');
  refused(await call(f.client, 'wiki_create_concept', { name: 'Deneme Kavram', content: 'Başka içerik.' }), 'E_ALREADY_EXISTS');
  assert.deepEqual(await snapshot(f.wiki), before, 'index, page and log are byte-identical after the refused calls');
});

test('secret-shaped name is refused: no page, no index change, no log line, and the value is not echoed', async (t) => {
  const f = await startServer(t, { files: FILES_LF });
  const before = await snapshot(f.wiki);
  const r = await call(f.client, 'wiki_create_entity', { name: `Anahtar ${SECRET_OPENAI}`, content: 'Not.' });
  const message = refused(r, 'E_SECRET_DETECTED');
  assert.ok(!message.includes(SECRET_OPENAI), 'the matched value is not returned');
  assert.deepEqual(await snapshot(f.wiki), before, 'nothing is written');
});

test('secret-shaped content is refused for both create tools: index and page stay unchanged', async (t) => {
  const f = await startServer(t, { files: FILES_LF });
  const before = await snapshot(f.wiki);
  const r1 = await call(f.client, 'wiki_create_entity', { name: 'Gizli Not', content: `Token metni ${SECRET_GITHUB} burada.` });
  const message = refused(r1, 'E_SECRET_DETECTED');
  assert.ok(!message.includes(SECRET_GITHUB), 'the matched value is not returned');
  refused(await call(f.client, 'wiki_create_concept', { name: 'Gizli Kavram', content: `Not ${SECRET_OPENAI}` }), 'E_SECRET_DETECTED');
  assert.deepEqual(await snapshot(f.wiki), before, 'nothing is written by either refused call');
});

test('stale entry beside the new one: create keeps it (one line added); wiki_update_index then removes only the stale line', async (t) => {
  const index = '# Wiki Index\n\n## entities\n\n- [Eski](entities/yok-sayfa.md) — silinmiş\n- [Ali](entities/ali.md)\n';
  const f = await startServer(t, { files: { 'index.md': index, 'entities/ali.md': page('Ali') } });
  const before = await readIndex(f);
  okJson(await call(f.client, 'wiki_create_entity', { name: 'Deneme Varlik', content: 'Ev.' }));
  const afterCreate = await readIndex(f);
  singleInsertion(before, afterCreate);
  assert.ok(afterCreate.toString('utf8').includes('- [Eski](entities/yok-sayfa.md) — silinmiş\n'), 'the stale line survives the create');
  assert.deepEqual(okJson(await call(f.client, 'wiki_update_index', {})), { indexed: 2, added: 0, removed: 1 });
  const afterUpdate = (await readIndex(f)).toString('utf8');
  assert.equal(afterUpdate, afterCreate.toString('utf8').replace('- [Eski](entities/yok-sayfa.md) — silinmiş\n', ''), 'only the stale line was removed');
  assert.deepEqual(okJson(await call(f.client, 'wiki_update_index', {})), { indexed: 2, added: 0, removed: 0 });
});

test('create entity with no index file: the fresh index holds only that one entry, in the entities category', async (t) => {
  const f = await startServer(t, { files: { 'entities/ali.md': page('Ali'), 'concepts/kavram.md': page('Kavram') } });
  okJson(await call(f.client, 'wiki_create_entity', { name: 'Deneme Varlik', content: 'Ev.' }));
  assert.equal((await readIndex(f)).toString('utf8'), '# Wiki Index\n\n## entities\n\n- [Deneme Varlik](entities/deneme-varlik.md)\n');
});
