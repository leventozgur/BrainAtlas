// SPDX-License-Identifier: MIT
// BA-14 independent retest (second blind pass). Covers symlink variants, read-tool visibility, case-insensitive
// categories, duplicate links across preface/categories, mixed CRLF/LF files, patch ordering and idempotency.
// Every case runs against a real stdio MCP server built from ROOT (worktree) or the main checkout (BA14_TARGET=main).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, symlink, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { startServer, call, okJson, refused, textOf, snapshot, logCount, SECRET } from './harness.mjs';

const page = (frontmatter, body = 'Gövde.') => `---\n${frontmatter}\n---\n${body}\n`;
const EMPTY_INDEX = '# Wiki Index\n\n';

/** Lines of `text` that exist, in order, as a subsequence of `lines` (exact string equality per line). */
function isSubsequence(survivors, lines) {
  let at = 0;
  for (const line of lines) if (at < survivors.length && line === survivors[at]) at++;
  return at === survivors.length;
}

// ---------------------------------------------------------------- symlink variants (wiki_update_index)

test('S1: page symlink to a target inside the vault is not indexed as a page and not listed in the index', async (t) => {
  const f = await startServer(t, {
    files: { 'concepts/real.md': page('title: Gerçek Sayfa'), 'entities/a.md': page('title: A'), 'index.md': EMPTY_INDEX }
  });
  await mkdir(join(f.wiki, 'entities'), { recursive: true });
  await symlink(join(f.wiki, 'concepts', 'real.md'), join(f.wiki, 'entities', 'alias.md'));
  assert.deepEqual(okJson(await call(f.client, 'wiki_update_index')), { indexed: 2, added: 2, removed: 0 });
  const out = await readFile(join(f.wiki, 'index.md'), 'utf8');
  assert.equal(out.includes('alias'), false, 'symlink name must not appear in the index');
  assert.equal(out.split('(concepts/real.md)').length - 1, 1, 'real page is listed exactly once');
});

test('S2: page symlink to a file outside the vault is never indexed, and the outside file is not read or changed', async (t) => {
  const f = await startServer(t, { files: { 'entities/a.md': page('title: A'), 'index.md': EMPTY_INDEX } });
  const outsideDir = join(f.dir, 'outside');
  await mkdir(outsideDir, { recursive: true });
  await writeFile(join(outsideDir, 'dis.md'), page('title: DISSAYFA-ZQ\nsummary: "DISOZET-ZQ"'));
  const outsideBefore = await snapshot(outsideDir);
  await symlink(join(outsideDir, 'dis.md'), join(f.wiki, 'entities', 'link.md'));
  assert.deepEqual(okJson(await call(f.client, 'wiki_update_index')), { indexed: 1, added: 1, removed: 0 });
  const out = await readFile(join(f.wiki, 'index.md'), 'utf8');
  assert.equal(/DISSAYFA-ZQ|DISOZET-ZQ|link\.md/.test(out), false, 'outside content or symlink name leaked into the index');
  assert.deepEqual(await snapshot(outsideDir), outsideBefore, 'outside file must be untouched');
});

test('S3: directory symlink inside the Wiki does not contribute its pages to the index', async (t) => {
  const f = await startServer(t, { files: { 'entities/a.md': page('title: A'), 'index.md': EMPTY_INDEX } });
  await symlink(join(f.wiki, 'entities'), join(f.wiki, 'alias'));
  assert.deepEqual(okJson(await call(f.client, 'wiki_update_index')), { indexed: 1, added: 1, removed: 0 });
  const out = await readFile(join(f.wiki, 'index.md'), 'utf8');
  assert.equal(out.includes('alias/'), false, 'pages reached through the directory symlink must not be listed');
  assert.equal(out.split('(entities/a.md)').length - 1, 1);
});

test('S4: deep directory symlink pointing outside the vault contributes no pages and leaves the log without its content', async (t) => {
  const f = await startServer(t, { files: { 'entities/a.md': page('title: A'), 'index.md': EMPTY_INDEX } });
  const outsideDir = join(f.dir, 'outside-deep');
  await mkdir(join(outsideDir, 'x', 'y'), { recursive: true });
  await writeFile(join(outsideDir, 'x', 'y', 'derin.md'), page('title: DERIN-ZQ'));
  await symlink(outsideDir, join(f.wiki, 'linkdir'));
  assert.deepEqual(okJson(await call(f.client, 'wiki_update_index')), { indexed: 1, added: 1, removed: 0 });
  assert.equal((await readFile(join(f.wiki, 'index.md'), 'utf8')).includes('DERIN-ZQ'), false);
  assert.equal((await readFile(join(f.wiki, 'log.md'), 'utf8')).includes('DERIN-ZQ'), false);
});

test('S5: wiki/ itself symlinked outside the vault: wiki_update_index refuses with E_PATH_ESCAPE and writes nothing outside', async (t) => {
  const f = await startServer(t);
  const outsideWiki = join(f.dir, 'outside-wiki');
  await mkdir(join(outsideWiki, 'entities'), { recursive: true });
  await writeFile(join(outsideWiki, 'entities', 'dis.md'), page('title: DISWIKI-ZQ'));
  await rm(f.wiki, { recursive: true, force: true });
  await symlink(outsideWiki, f.wiki);
  const before = await snapshot(outsideWiki);
  refused(await call(f.client, 'wiki_update_index'), 'E_PATH_ESCAPE');
  assert.deepEqual(await snapshot(outsideWiki), before, 'no index or log may be created outside the vault');
});

test('S6: vault root is itself a symlink to a real directory (legitimate layout): index works and indexes its pages', async (t) => {
  const f = await startServer(t, { files: { 'entities/a.md': page('title: A'), 'concepts/k.md': page('title: K'), 'index.md': EMPTY_INDEX } });
  await rename(f.vault, join(f.dir, 'realvault'));
  await symlink(join(f.dir, 'realvault'), f.vault);
  assert.deepEqual(okJson(await call(f.client, 'wiki_update_index')), { indexed: 2, added: 2, removed: 0 });
  const out = await readFile(join(f.dir, 'realvault', 'wiki', 'index.md'), 'utf8');
  assert.ok(out.includes('(entities/a.md)') && out.includes('(concepts/k.md)'));
});

// ---------------------------------------------------------------- read tools never expose outside/symlinked pages

test('S7: wiki_list_pages, wiki_status and wiki_query hide page and directory symlinks that point outside the vault', async (t) => {
  const f = await startServer(t, { files: { 'entities/real.md': page('title: Gerçek INSIDEZQ') } });
  const outsideDir = join(f.dir, 'outside');
  await mkdir(join(outsideDir, 'sub'), { recursive: true });
  await writeFile(join(outsideDir, 'file.md'), page('title: Dış OUTSIDEZQ'));
  await writeFile(join(outsideDir, 'sub', 'deep.md'), page('title: Dış DEEPZQ'));
  await symlink(join(outsideDir, 'file.md'), join(f.wiki, 'entities', 'link.md'));
  await symlink(outsideDir, join(f.wiki, 'linkdir'));
  const list = okJson(await call(f.client, 'wiki_list_pages', {}));
  assert.deepEqual(list.pages, ['wiki/entities/real.md']);
  const status = okJson(await call(f.client, 'wiki_status', {}));
  assert.equal(status.pageCount, 1);
  const inside = okJson(await call(f.client, 'wiki_query', { query: 'INSIDEZQ' }));
  assert.ok(inside.results.some((row) => row.path === 'entities/real.md'), 'positive control: in-vault page is found');
  for (const marker of ['OUTSIDEZQ', 'DEEPZQ']) {
    const r = textOf(await call(f.client, 'wiki_query', { query: marker }));
    assert.equal(r.includes(marker), false, `wiki_query leaked ${marker}`);
  }
});

test('S8: wiki/ symlinked outside the vault: read tools must not expose outside pages (consistent with the index refusal)', async (t) => {
  const f = await startServer(t);
  const outsideWiki = join(f.dir, 'outside-wiki');
  await mkdir(join(outsideWiki, 'entities'), { recursive: true });
  await writeFile(join(outsideWiki, 'entities', 'dis.md'), page('title: DISWIKI-ZQ'));
  await rm(f.wiki, { recursive: true, force: true });
  await symlink(outsideWiki, f.wiki);
  const list = okJson(await call(f.client, 'wiki_list_pages', {}));
  assert.deepEqual(list.pages, [], `wiki_list_pages exposed outside pages: ${JSON.stringify(list.pages)}`);
  const status = okJson(await call(f.client, 'wiki_status', {}));
  assert.equal(status.pageCount, 0, 'wiki_status counted outside pages');
  const q = textOf(await call(f.client, 'wiki_query', { query: 'DISWIKI-ZQ' }));
  assert.equal(q.includes('DISWIKI-ZQ'), false, 'wiki_query returned an outside page');
});

// ---------------------------------------------------------------- categories, duplicates, preface

test('C1: a category heading in another letter case (## Entities) receives the new page; no second heading is created', async (t) => {
  const f = await startServer(t, {
    files: {
      'entities/a.md': page('title: A'),
      'entities/new.md': page('title: Yeni'),
      'concepts/k.md': page('title: K'),
      'index.md': '# Wiki Index\n\n## Entities\n\n- [A](entities/a.md)\n\n## concepts\n\n- [K](concepts/k.md)\n'
    }
  });
  assert.deepEqual(okJson(await call(f.client, 'wiki_update_index')), { indexed: 3, added: 1, removed: 0 });
  assert.equal(
    await readFile(join(f.wiki, 'index.md'), 'utf8'),
    '# Wiki Index\n\n## Entities\n\n- [A](entities/a.md)\n- [Yeni](entities/new.md)\n\n## concepts\n\n- [K](concepts/k.md)\n'
  );
});

test('C2: upper-case ## ENTITIES heading with no entries receives the page under it', async (t) => {
  const f = await startServer(t, { files: { 'entities/new.md': page('title: Yeni'), 'index.md': '# Wiki Index\n\n## ENTITIES\n\n' } });
  assert.deepEqual(okJson(await call(f.client, 'wiki_update_index')), { indexed: 1, added: 1, removed: 0 });
  assert.equal(await readFile(join(f.wiki, 'index.md'), 'utf8'), '# Wiki Index\n\n## ENTITIES\n\n- [Yeni](entities/new.md)\n');
});

test('P1: a page linked from the preface and from a different category counts as linked; no duplicate line is added', async (t) => {
  const index = '# Wiki Index\n\n- [A](entities/a.md) — önsöz\n\n## concepts\n\n- [A tekrar](entities/a.md) — ikinci\n\n## entities\n\n';
  const f = await startServer(t, { files: { 'entities/a.md': page('title: A'), 'concepts/b.md': page('title: B'), 'index.md': index } });
  assert.deepEqual(okJson(await call(f.client, 'wiki_update_index')), { indexed: 2, added: 1, removed: 0 });
  assert.equal(
    await readFile(join(f.wiki, 'index.md'), 'utf8'),
    '# Wiki Index\n\n- [A](entities/a.md) — önsöz\n\n## concepts\n\n- [A tekrar](entities/a.md) — ikinci\n- [B](concepts/b.md)\n\n## entities\n\n'
  );
});

test('P2: a deleted page linked from the preface and from two categories loses every stale line', async (t) => {
  const index = '# Wiki Index\n\n- [Gone](entities/gone.md) — önsöz\n\n## concepts\n\n- [Gone 2](entities/gone.md)\n\n## entities\n\n- [Gone 3](entities/gone.md)\n';
  const f = await startServer(t, { files: { 'entities/a.md': page('title: A'), 'index.md': index } });
  assert.deepEqual(okJson(await call(f.client, 'wiki_update_index')), { indexed: 1, added: 1, removed: 3 });
  const out = await readFile(join(f.wiki, 'index.md'), 'utf8');
  assert.equal(out.includes('gone.md'), false);
  assert.equal(out.split('(entities/a.md)').length - 1, 1);
});

// ---------------------------------------------------------------- mixed line endings

test('M1: mixed CRLF and LF lines: surviving lines keep their bytes, no bare CR, a second run is a no-op', async (t) => {
  const orig = '# Wiki Index\r\n\n## entities\r\n- [Ahmet](entities/ahmet.md) — özet\n- [Gone](entities/gone.md) — eski\r\n\n## concepts\n- [K](concepts/k.md)\r\n';
  const f = await startServer(t, {
    files: { 'entities/ahmet.md': page('title: Ahmet'), 'entities/yeni.md': page('title: Yeni'), 'concepts/k.md': page('title: K'), 'index.md': orig }
  });
  assert.deepEqual(okJson(await call(f.client, 'wiki_update_index')), { indexed: 3, added: 1, removed: 1 });
  const out = await readFile(join(f.wiki, 'index.md'), 'utf8');
  assert.equal(/\r(?!\n)/.test(out), false, 'no bare CR may appear');
  const survivors = orig.split('\n').filter((line) => !line.includes('gone.md'));
  assert.ok(isSubsequence(survivors, out.split('\n')), 'every surviving original line must be kept byte for byte, in order');
  assert.ok(out.includes('- [Yeni](entities/yeni.md)'), 'new page line is present');
  const after = await readFile(join(f.wiki, 'index.md'));
  assert.deepEqual(okJson(await call(f.client, 'wiki_update_index')), { indexed: 3, added: 0, removed: 0 });
  assert.deepEqual(await readFile(join(f.wiki, 'index.md')), after, 'second run must not change bytes');
});

test('M2: CRLF file whose removed last stale line is LF-terminated ends with a clean CRLF tail', async (t) => {
  const orig = '# Wiki Index\r\n\r\n## entities\r\n- [A](entities/a.md)\r\n- [Gone](entities/gone.md)\n';
  const f = await startServer(t, { files: { 'entities/a.md': page('title: A'), 'index.md': orig } });
  assert.deepEqual(okJson(await call(f.client, 'wiki_update_index')), { indexed: 1, added: 0, removed: 1 });
  assert.equal(await readFile(join(f.wiki, 'index.md'), 'utf8'), '# Wiki Index\r\n\r\n## entities\r\n- [A](entities/a.md)\r\n');
});

// ---------------------------------------------------------------- idempotency

for (const [label, body] of [
  ['LF', '# Wiki Index\n\n## entities\n\n- [Eski](entities/eski.md) — özet\n'],
  ['CRLF', '# Wiki Index\r\n\r\n## entities\r\n\r\n- [Eski](entities/eski.md) — özet\r\n'],
  ['mixed', '# Wiki Index\r\n\n## entities\n- [Eski](entities/eski.md)\r\n']
]) {
  test(`I1 (${label}): second wiki_update_index run reports added=0 removed=0 and leaves the bytes unchanged`, async (t) => {
    const f = await startServer(t, { files: { 'entities/eski.md': page('title: Eski'), 'entities/yeni boşluk.md': page('title: Boşluklu'), 'index.md': body } });
    const first = okJson(await call(f.client, 'wiki_update_index'));
    assert.equal(first.added, 1);
    const afterFirst = await readFile(join(f.wiki, 'index.md'));
    assert.deepEqual(okJson(await call(f.client, 'wiki_update_index')), { indexed: 2, added: 0, removed: 0 });
    assert.deepEqual(await readFile(join(f.wiki, 'index.md')), afterFirst);
  });
}

test('I2: a page whose file name contains parentheses is listed once; a second run must not add it again', async (t) => {
  const f = await startServer(t, { files: { 'entities/a(b).md': page('title: Parantezli'), 'index.md': EMPTY_INDEX } });
  assert.deepEqual(okJson(await call(f.client, 'wiki_update_index')), { indexed: 1, added: 1, removed: 0 });
  const afterFirst = await readFile(join(f.wiki, 'index.md'));
  assert.deepEqual(okJson(await call(f.client, 'wiki_update_index')), { indexed: 1, added: 0, removed: 0 });
  assert.deepEqual(await readFile(join(f.wiki, 'index.md')), afterFirst);
});

// ---------------------------------------------------------------- wiki_update_page patch ordering and validation

const PAGE_PATH = 'entities/p.md';
const PAGE = '---\ntype: entity\ntitle: Patch Sayfası\nstatus: active\n---\nEski gövde 🧪\n';
// Body text after the closing frontmatter fence, without surrounding newlines (serialization whitespace is not under test).
const parsedBody = async (f) => (await readFile(join(f.wiki, PAGE_PATH), 'utf8')).split('---\n').slice(2).join('---\n').trim();

test('PA1: body then append are applied in order and the old body is gone (exact bytes)', async (t) => {
  const f = await startServer(t, { files: { [PAGE_PATH]: PAGE } });
  assert.equal(okJson(await call(f.client, 'wiki_update_page', { path: PAGE_PATH, patch: { body: 'B', append: '\nA' } })).updated, true);
  assert.equal(await parsedBody(f), 'B\nA');
});

test('PA2: frontmatter, body and append together: frontmatter merges, body is replaced then appended', async (t) => {
  const f = await startServer(t, { files: { [PAGE_PATH]: PAGE } });
  assert.equal(okJson(await call(f.client, 'wiki_update_page', { path: PAGE_PATH, patch: { frontmatter: { status: 'confirmed' }, body: 'Yeni', append: '\nEk' } })).updated, true);
  const text = await readFile(join(f.wiki, PAGE_PATH), 'utf8');
  assert.match(text, /status: confirmed/);
  assert.match(text, /title: Patch Sayfası/, 'untouched frontmatter key survives');
  assert.equal(await parsedBody(f), 'Yeni\nEk');
});

test('PA3: frontmatter and append only: the existing body is kept and the appended text follows it', async (t) => {
  const f = await startServer(t, { files: { [PAGE_PATH]: PAGE } });
  assert.equal(okJson(await call(f.client, 'wiki_update_page', { path: PAGE_PATH, patch: { frontmatter: { status: 'superseded' }, append: '\nSon' } })).updated, true);
  assert.equal(await parsedBody(f), 'Eski gövde 🧪\nSon');
});

test('PA4: empty body string with append yields only the appended text', async (t) => {
  const f = await startServer(t, { files: { [PAGE_PATH]: PAGE } });
  assert.equal(okJson(await call(f.client, 'wiki_update_page', { path: PAGE_PATH, patch: { body: '', append: 'Z' } })).updated, true);
  assert.equal(await parsedBody(f), 'Z');
});

test('PA5: secret-shaped text in append is refused with E_SECRET_DETECTED; the page and log are unchanged', async (t) => {
  const f = await startServer(t, { files: { [PAGE_PATH]: PAGE } });
  const before = await snapshot(f.vault);
  const logBefore = await logCount(f.wiki, 'update-page');
  const r = await call(f.client, 'wiki_update_page', { path: PAGE_PATH, patch: { body: 'Temiz', append: `\npassword: ${SECRET}` } });
  refused(r, 'E_SECRET_DETECTED');
  assert.equal(textOf(r).includes(SECRET), false);
  assert.deepEqual(await snapshot(f.vault), before);
  assert.equal(await logCount(f.wiki, 'update-page'), logBefore);
});

const PA6_CASES = [
  ['capitalised Body', '{"Body":"MARK-PA6-1"}'],
  ['capitalised Append', '{"Append":"MARK-PA6-2"}'],
  ['valid body beside capitalised Append', '{"body":"MARK-PA6-3","Append":"MARK-PA6-4"}'],
  ['key with trailing space', '{"frontmatter ":{"status":"MARK-PA6-5"}}'],
  ['constructor key', '{"constructor":"MARK-PA6-6"}'],
  ['__proto__ key', '{"__proto__":{"x":"MARK-PA6-7"}}'],
  ['non-string append beside valid body', '{"body":"MARK-PA6-8","append":5}']
];
for (const [label, raw] of PA6_CASES) {
  test(`PA6 (${label}): unknown patch key is refused with E_INVALID_INPUT, no echo, nothing written or logged`, async (t) => {
    const f = await startServer(t, { files: { [PAGE_PATH]: PAGE } });
    const before = await snapshot(f.vault);
    const logBefore = await logCount(f.wiki, 'update-page');
    const r = await call(f.client, 'wiki_update_page', { path: PAGE_PATH, patch: JSON.parse(raw) });
    refused(r, 'E_INVALID_INPUT');
    assert.equal(/MARK-PA6/.test(textOf(r)), false, 'message echoes caller value');
    assert.deepEqual(await snapshot(f.vault), before, 'file changed');
    assert.equal(await logCount(f.wiki, 'update-page'), logBefore, 'log changed');
  });
}
