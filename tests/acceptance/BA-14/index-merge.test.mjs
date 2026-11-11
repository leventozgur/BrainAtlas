// SPDX-License-Identifier: MIT
// BA-14 blind acceptance: wiki_update_index minimal edit, over a real stdio MCP client/server.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { startServer, call, okJson, refused, textOf, snapshot, logCount, readOrNull, SECRET } from './harness.mjs';

const page = (frontmatter, body = 'Gövde.') => `---\n${frontmatter}\n---\n${body}\n`;
const lf = (lines) => lines.join('\n');
const crlf = (lines) => lines.join('\r\n');

// Pages on disk for the main fixture. Includes a subfolder page, a renamed page, a bracketed title, and a page
// that is linked twice in the index.
const MAIN_PAGES = {
  'entities/ahmet.md': page('type: entity\ntitle: Ahmet Yılmaz\nsummary: "Türkçe özet 🚀 çok önemli"\ntags: [kişi, türkçe]'),
  'entities/x/y.md': page('title: Derin Sayfa'),
  'entities/yeni.md': page('title: "Yeni Sayfa [test]"\nsummary: "Yeni özet 🎉"\ntags: [yeni, proje]'),
  'entities/yeni-ad.md': page('title: Yeni Ad'),
  'concepts/kavram-a.md': page('title: Kavram A'),
  'concepts/kavram-b.md': page('title: Kavram B\ndescription: "B özet"')
};

// Hand-edited index: Turkish and emoji summaries, several tags, out-of-order categories, a blockquote note,
// a plain paragraph inside a category, external and anchor links, a duplicate entry, a ### sub-heading, a stale
// entry (deleted page) and a stale entry for a renamed page. Trailing newline present.
const INDEX_MAIN = [
  '# Wiki Index',
  '',
  'Bu index elle düzenlendi; ilk paragraf korunmalı.',
  '',
  '> Not: bu alıntı satırı aynen kalmalı. 🔒',
  '',
  '## concepts',
  '',
  '- [Kavram A](concepts/kavram-a.md) — Kavram özeti: Türkçe ✅ #kavram',
  'Serbest paragraf: giriş değil, aynen kalmalı.',
  '',
  '## entities',
  '',
  '- [Ahmet Yılmaz](entities/ahmet.md) — Türkçe özet: çok önemli 🚀 #kişi #türkçe',
  '- [Silinen](entities/silinen.md) — eski özet #eski',
  '- [Harici](https://example.com/a.md) — dış bağlantı',
  '- [Çapa](#bolum) — sayfa içi çapa',
  '- [Kopya](entities/ahmet.md) — aynı sayfaya ikinci satır #iki',
  '',
  '### Alt not',
  'Bu alt başlık ve paragraf aynen kalmalı.',
  '',
  '## Ana notlar',
  '',
  '- [Eski ad](entities/eski-ad.md) — yeniden adlandırıldı',
  ''
];

// Expected result for INDEX_MAIN with MAIN_PAGES: added Kavram B, Derin Sayfa, Yeni Ad, Yeni Sayfa; removed Silinen, Eski ad.
const EXPECTED_MAIN = [
  '# Wiki Index',
  '',
  'Bu index elle düzenlendi; ilk paragraf korunmalı.',
  '',
  '> Not: bu alıntı satırı aynen kalmalı. 🔒',
  '',
  '## concepts',
  '',
  '- [Kavram A](concepts/kavram-a.md) — Kavram özeti: Türkçe ✅ #kavram',
  '- [Kavram B](concepts/kavram-b.md) — B özet',
  'Serbest paragraf: giriş değil, aynen kalmalı.',
  '',
  '## entities',
  '',
  '- [Ahmet Yılmaz](entities/ahmet.md) — Türkçe özet: çok önemli 🚀 #kişi #türkçe',
  '- [Harici](https://example.com/a.md) — dış bağlantı',
  '- [Çapa](#bolum) — sayfa içi çapa',
  '- [Kopya](entities/ahmet.md) — aynı sayfaya ikinci satır #iki',
  '- [Derin Sayfa](entities/x/y.md)',
  '- [Yeni Ad](entities/yeni-ad.md)',
  '- [Yeni Sayfa \\[test\\]](entities/yeni.md) — Yeni özet 🎉 #yeni #proje',
  '',
  '### Alt not',
  'Bu alt başlık ve paragraf aynen kalmalı.',
  '',
  '## Ana notlar',
  '',
  ''
];

test('R1: hand-written summaries, tags, notes, paragraphs and sub-headings survive wiki_update_index (brief bug 1)', async (t) => {
  const f = await startServer(t, { files: { ...MAIN_PAGES, 'index.md': lf(INDEX_MAIN) } });
  okJson(await call(f.client, 'wiki_update_index'));
  const out = await readFile(join(f.wiki, 'index.md'), 'utf8');
  for (const kept of [
    '- [Ahmet Yılmaz](entities/ahmet.md) — Türkçe özet: çok önemli 🚀 #kişi #türkçe',
    '- [Kavram A](concepts/kavram-a.md) — Kavram özeti: Türkçe ✅ #kavram',
    '> Not: bu alıntı satırı aynen kalmalı. 🔒',
    'Serbest paragraf: giriş değil, aynen kalmalı.',
    'Bu index elle düzenlendi; ilk paragraf korunmalı.',
    '### Alt not',
    '- [Harici](https://example.com/a.md) — dış bağlantı',
    '- [Çapa](#bolum) — sayfa içi çapa'
  ]) {
    assert.ok(out.split('\n').includes(kept), `lost: ${kept}`);
  }
});

test('R2: unknown patch key is refused with E_INVALID_INPUT and leaves file and log untouched (brief bug 2)', async (t) => {
  const f = await startServer(t, { files: { 'entities/p.md': page('title: Eski Başlık') } });
  const before = await snapshot(f.vault);
  refused(await call(f.client, 'wiki_update_page', { path: 'entities/p.md', patch: { title: 'MARK-R2' } }), 'E_INVALID_INPUT');
  assert.deepEqual(await snapshot(f.vault), before);
});

test('A: hand-edited index (LF) keeps surviving lines byte for byte, adds and removes only the diff, is idempotent', async (t) => {
  const f = await startServer(t, { files: { ...MAIN_PAGES, 'index.md': lf(INDEX_MAIN) } });
  const logBefore = await logCount(f.wiki, 'update-index');
  const first = okJson(await call(f.client, 'wiki_update_index'));
  assert.deepEqual(first, { indexed: 6, added: 4, removed: 2 });
  assert.equal(await readFile(join(f.wiki, 'index.md'), 'utf8'), lf(EXPECTED_MAIN));
  assert.equal(await logCount(f.wiki, 'update-index'), logBefore + 1, 'one log record per successful update');
  const afterFirst = await readFile(join(f.wiki, 'index.md'));
  const second = okJson(await call(f.client, 'wiki_update_index'));
  assert.deepEqual(second, { indexed: 6, added: 0, removed: 0 });
  assert.deepEqual(await readFile(join(f.wiki, 'index.md')), afterFirst, 'second run must not change bytes');
});

test('B: the same hand-edited index with CRLF line endings keeps CRLF on every line', async (t) => {
  const f = await startServer(t, { files: { ...MAIN_PAGES, 'index.md': crlf(INDEX_MAIN) } });
  assert.deepEqual(okJson(await call(f.client, 'wiki_update_index')), { indexed: 6, added: 4, removed: 2 });
  assert.equal(await readFile(join(f.wiki, 'index.md'), 'utf8'), crlf(EXPECTED_MAIN));
});

test('C: LF index without a final newline gets a new category appended and keeps its last line bytes', async (t) => {
  const original = ['# Wiki Index', '', '## concepts', '', '- [Kavram A](concepts/kavram-a.md) — son satır'];
  const f = await startServer(t, {
    files: {
      'concepts/kavram-a.md': page('title: Kavram A'),
      'notes/n.md': page('title: Not N\ntags: [a]'),
      'index.md': lf(original)
    }
  });
  assert.deepEqual(okJson(await call(f.client, 'wiki_update_index')), { indexed: 2, added: 1, removed: 0 });
  assert.equal(await readFile(join(f.wiki, 'index.md'), 'utf8'), lf([...original, '', '## notes', '', '- [Not N](notes/n.md) — #a']));
});

test('D: CRLF index without a final newline ends with a clean line ending after a removed last line', async (t) => {
  const withoutLastEmpty = INDEX_MAIN.slice(0, -1); // last line is the stale entry, no EOL after it
  const f = await startServer(t, { files: { ...MAIN_PAGES, 'index.md': crlf(withoutLastEmpty) } });
  assert.deepEqual(okJson(await call(f.client, 'wiki_update_index')), { indexed: 6, added: 4, removed: 2 });
  const out = await readFile(join(f.wiki, 'index.md'), 'utf8');
  assert.match(out, /## Ana notlar\r\n(\r\n)?$/, `file tail must end with CRLF, got ${JSON.stringify(out.slice(-40))}`);
  assert.equal(/\r(?!\n)/.test(out), false, 'no bare CR may appear in a CRLF file');
  assert.equal(out.includes('- [Derin Sayfa](entities/x/y.md)'), true);
});

test('E: missing index is rebuilt from pages with the legacy shape and the new return fields', async (t) => {
  const f = await startServer(t, { files: { ...MAIN_PAGES } });
  const r = okJson(await call(f.client, 'wiki_update_index'));
  assert.deepEqual(r, { indexed: 6, added: 6, removed: 0 });
  const out = await readFile(join(f.wiki, 'index.md'), 'utf8');
  assert.ok(out.startsWith('# Wiki Index\n'));
  for (const link of ['(entities/ahmet.md)', '(entities/x/y.md)', '(entities/yeni.md)', '(concepts/kavram-b.md)']) {
    assert.ok(out.includes(link), `missing ${link}`);
  }
  assert.ok(out.includes('- [Ahmet Yılmaz](entities/ahmet.md)'));
});

test('E2: zero-byte index is treated as missing and rebuilt', async (t) => {
  const f = await startServer(t, { files: { ...MAIN_PAGES, 'index.md': '' } });
  assert.deepEqual(okJson(await call(f.client, 'wiki_update_index')), { indexed: 6, added: 6, removed: 0 });
  assert.ok((await readFile(join(f.wiki, 'index.md'), 'utf8')).startsWith('# Wiki Index\n'));
});

test('F: empty vault keeps headings and notes, removes every stale entry, and reports counts', async (t) => {
  const index = '# Wiki Index\n\nNot satırı\n\n## entities\n\n- [Yok](entities/yok.md) — eski\n';
  const f = await startServer(t, { files: { 'index.md': index } });
  assert.deepEqual(okJson(await call(f.client, 'wiki_update_index')), { indexed: 0, added: 0, removed: 1 });
  assert.equal(await readFile(join(f.wiki, 'index.md'), 'utf8'), '# Wiki Index\n\nNot satırı\n\n## entities\n\n');
});

test('F2: empty vault without an index writes the bare header and zero counts', async (t) => {
  const f = await startServer(t);
  assert.deepEqual(okJson(await call(f.client, 'wiki_update_index')), { indexed: 0, added: 0, removed: 0 });
  assert.equal(await readFile(join(f.wiki, 'index.md'), 'utf8'), '# Wiki Index\n');
});

test('G: many categories, out-of-order headings, new page placed under its own folder heading', async (t) => {
  const folders = Array.from({ length: 30 }, (_, i) => `f${String(i).padStart(2, '0')}`);
  const files = {};
  let index = '# Wiki Index\n\n';
  for (const folder of [...folders].reverse()) {
    files[`${folder}/p.md`] = page(`title: P ${folder}`);
    files[`${folder}/n.md`] = page(`title: N ${folder}`);
    index += `## ${folder}\n\n- [P ${folder}](${folder}/p.md) — özet ${folder}\n\n`;
  }
  files['index.md'] = index;
  const f = await startServer(t, { files });
  assert.deepEqual(okJson(await call(f.client, 'wiki_update_index')), { indexed: 60, added: 30, removed: 0 });
  const lines = (await readFile(join(f.wiki, 'index.md'), 'utf8')).split('\n');
  const headings = lines.filter((line) => line.startsWith('## '));
  assert.deepEqual(headings, [...folders].reverse().map((folder) => `## ${folder}`), 'category order is preserved');
  for (const folder of folders) {
    const start = lines.indexOf(`## ${folder}`);
    const end = lines.findIndex((line, i) => i > start && line.startsWith('## '));
    const section = lines.slice(start, end === -1 ? undefined : end);
    assert.ok(section.includes(`- [P ${folder}](${folder}/p.md) — özet ${folder}`), `${folder} keeps its hand summary`);
    assert.ok(section.includes(`- [N ${folder}](${folder}/n.md)`), `${folder} gets its new page in the same section`);
    assert.ok(section.indexOf(`- [N ${folder}](${folder}/n.md)`) > section.indexOf(`- [P ${folder}](${folder}/p.md) — özet ${folder}`), 'new line comes after the last entry');
  }
});

test('H: titles with brackets and parentheses are escaped, and the escaped line is recognized on the next run', async (t) => {
  const f = await startServer(t, {
    files: { 'entities/kapanis.md': page('title: "Kapanış [v2] (taslak)"'), 'index.md': '# Wiki Index\n\n## entities\n\n' }
  });
  assert.deepEqual(okJson(await call(f.client, 'wiki_update_index')), { indexed: 1, added: 1, removed: 0 });
  assert.equal(await readFile(join(f.wiki, 'index.md'), 'utf8'), '# Wiki Index\n\n## entities\n\n- [Kapanış \\[v2\\] \\(taslak\\)](entities/kapanis.md)\n');
  assert.deepEqual(okJson(await call(f.client, 'wiki_update_index')), { indexed: 1, added: 0, removed: 0 });
});

test('I: summary precedence, description fallback, whitespace normalization and word-like tag filtering', async (t) => {
  const f = await startServer(t, {
    files: {
      'concepts/a.md': page('title: "  Çok   boşluk  "\nsummary: "S1  özet"\ndescription: "D1"\ntags: [ok-tag, "bad tag", üç]'),
      'concepts/b.md': page('title: Yalnız açıklama\ndescription: "D2"'),
      'concepts/c.md': page('title: Boş özet\nsummary: "   "\ndescription: "D3"'),
      'concepts/d.md': page('title: Metin etiket\ntags: "tek"'),
      'index.md': '# Wiki Index\n\n## concepts\n\n'
    }
  });
  assert.deepEqual(okJson(await call(f.client, 'wiki_update_index')), { indexed: 4, added: 4, removed: 0 });
  const out = await readFile(join(f.wiki, 'index.md'), 'utf8');
  assert.ok(out.includes('- [Çok boşluk](concepts/a.md) — S1 özet #ok-tag'), out);
  assert.ok(out.includes('- [Yalnız açıklama](concepts/b.md) — D2'), out);
  assert.ok(out.includes('- [Boş özet](concepts/c.md) — D3'), out);
  assert.ok(out.includes('- [Metin etiket](concepts/d.md)'), out);
  assert.ok(!/bad|üç/.test(out.split('\n').filter((l) => l.includes('concepts/a.md')).join('\n')), 'non word-like tags are dropped');
});

test('J: category-less entry lines are kept byte for byte and an existing page is not listed a second time', async (t) => {
  const index = ['# Wiki Index', '', '- [Önsöz](entities/onsoz.md) — giriş satırı', '', '## concepts', '', '- [Kavram A](concepts/kavram-a.md)', ''].join('\n');
  const f = await startServer(t, {
    files: { 'entities/onsoz.md': page('title: Önsöz'), 'concepts/kavram-a.md': page('title: Kavram A'), 'index.md': index }
  });
  const r = okJson(await call(f.client, 'wiki_update_index'));
  assert.deepEqual(r, { indexed: 2, added: 0, removed: 0 }, 'the page is already linked in the index');
  assert.equal(await readFile(join(f.wiki, 'index.md'), 'utf8'), index);
});

test('J2: category-less entry line whose page was deleted is removed like any other stale entry', async (t) => {
  const index = ['# Wiki Index', '', '- [Silinmiş](entities/silinmis.md) — eski satır', '', '## concepts', '', '- [Kavram A](concepts/kavram-a.md)', ''].join('\n');
  const f = await startServer(t, { files: { 'concepts/kavram-a.md': page('title: Kavram A'), 'index.md': index } });
  assert.deepEqual(okJson(await call(f.client, 'wiki_update_index')), { indexed: 1, added: 0, removed: 1 });
  assert.equal(await readFile(join(f.wiki, 'index.md'), 'utf8'), ['# Wiki Index', '', '', '## concepts', '', '- [Kavram A](concepts/kavram-a.md)', ''].join('\n'));
});

test('K: a secret-shaped summary in a new page refuses the write; index and log are unchanged and the secret is not echoed', async (t) => {
  const index = '# Wiki Index\n\n## entities\n\n- [Ahmet Yılmaz](entities/ahmet.md) — özet\n';
  const f = await startServer(t, {
    files: { 'entities/ahmet.md': page('title: Ahmet Yılmaz'), 'entities/gizli.md': page(`title: Gizli\nsummary: "password: ${SECRET}"`), 'index.md': index }
  });
  const before = await snapshot(f.vault);
  const r = await call(f.client, 'wiki_update_index');
  refused(r, 'E_SECRET_DETECTED');
  assert.equal(textOf(r).includes(SECRET), false);
  assert.deepEqual(await snapshot(f.vault), before, 'no file, index or log changes on refusal');
});

test('K2: a secret-shaped title in a new page refuses the write the same way', async (t) => {
  const index = '# Wiki Index\n\n## entities\n\n';
  const f = await startServer(t, { files: { 'entities/gizli-baslik.md': page(`title: "${SECRET}"`), 'index.md': index } });
  const before = await snapshot(f.vault);
  const r = await call(f.client, 'wiki_update_index');
  refused(r, 'E_SECRET_DETECTED');
  assert.equal(textOf(r).includes(SECRET), false);
  assert.deepEqual(await snapshot(f.vault), before);
});

test('L: a symlinked page file is not added to the index and its target is never read into it', async (t) => {
  const f = await startServer(t, { files: { ...MAIN_PAGES, 'index.md': '# Wiki Index\n\n## entities\n\n' } });
  const outside = join(f.dir, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'dis.md'), page('title: Dış Sayfa\nsummary: "DIS-OZET"'));
  const { symlink } = await import('node:fs/promises');
  await symlink(join(outside, 'dis.md'), join(f.wiki, 'entities', 'link.md'));
  const r = okJson(await call(f.client, 'wiki_update_index'));
  const out = await readFile(join(f.wiki, 'index.md'), 'utf8');
  assert.equal(out.includes('Dış Sayfa'), false, 'symlinked page must not be indexed');
  assert.equal(out.includes('DIS-OZET'), false);
  assert.equal(r.indexed, 6, 'symlinked page is not counted as an indexed page');
});

test('L2: a symlinked directory that points outside the Wiki contributes no pages', async (t) => {
  const f = await startServer(t, { files: { 'index.md': '# Wiki Index\n\n## entities\n\n' } });
  const outside = join(f.dir, 'outside-dir');
  await mkdir(outside);
  await writeFile(join(outside, 'ddis.md'), page('title: Dizin Dışı'));
  const { symlink } = await import('node:fs/promises');
  await symlink(outside, join(f.wiki, 'evil'));
  const r = okJson(await call(f.client, 'wiki_update_index'));
  assert.equal(r.indexed, 0);
  assert.equal((await readFile(join(f.wiki, 'index.md'), 'utf8')).includes('Dizin Dışı'), false);
});

test('M: an index that is a symlink to a file outside the Wiki is refused and never read or echoed', async (t) => {
  const f = await startServer(t, { files: { 'entities/ahmet.md': page('title: Ahmet') } });
  const outside = join(f.dir, 'outside-index.md');
  await writeFile(outside, 'OUT-MARK-DO-NOT-ECHO\n');
  const { symlink, rm: rmFile } = await import('node:fs/promises');
  await rmFile(join(f.wiki, 'index.md'), { force: true });
  await symlink(outside, join(f.wiki, 'index.md'));
  const r = await call(f.client, 'wiki_update_index');
  refused(r, 'E_PATH_ESCAPE');
  assert.equal(textOf(r).includes('OUT-MARK'), false);
  assert.equal(await readFile(outside, 'utf8'), 'OUT-MARK-DO-NOT-ECHO\n');
});

test('N: traversal-looking entries in an existing index never gain new lines pointing outside the Wiki', async (t) => {
  const index = '# Wiki Index\n\n## entities\n\n- [Dış](../outside.md) — dışarı\n';
  const f = await startServer(t, { files: { 'entities/ahmet.md': page('title: Ahmet'), 'index.md': index } });
  await writeFile(join(f.dir, 'outside.md'), page('title: Dışarıda'));
  const r = okJson(await call(f.client, 'wiki_update_index'));
  const out = await readFile(join(f.wiki, 'index.md'), 'utf8');
  assert.equal(out.includes('Dışarıda'), false);
  assert.equal(r.added, 1, 'only the real page is added');
  assert.equal(out.split('\n').filter((line) => line.includes('../')).every((line) => index.includes(line)), true, 'no new traversal line');
});

test('O: a page inside a subfolder is listed under its first folder category, and log records the update', async (t) => {
  const f = await startServer(t, { files: { 'entities/deep/er/page.md': page('title: Derin Yol'), 'index.md': '# Wiki Index\n\n## entities\n\n' } });
  const before = await logCount(f.wiki, 'update-index');
  assert.deepEqual(okJson(await call(f.client, 'wiki_update_index')), { indexed: 1, added: 1, removed: 0 });
  assert.ok((await readFile(join(f.wiki, 'index.md'), 'utf8')).includes('- [Derin Yol](entities/deep/er/page.md)'));
  assert.equal(await logCount(f.wiki, 'update-index'), before + 1);
  assert.equal(await readOrNull(join(f.wiki, 'log.md')) !== null, true);
});
