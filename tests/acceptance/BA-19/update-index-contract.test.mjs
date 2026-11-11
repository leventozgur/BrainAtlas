// SPDX-License-Identifier: MIT
// BA-19 blind acceptance: wiki_update_index behaviour on hand-edited indexes, as stated in docs/contracts/mcp-tools.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { call, okJson, refused, readIndex, snapshot, singleInsertion, startServer, linkDestinations, SECRET_OPENAI } from './harness.mjs';

const page = (title, extra = '') => `---\ntitle: ${title}\n${extra}---\nKısa gövde.\n`;

test('lines inside a fenced block are opaque: a fenced entry does not count as linked, and the real entry is added outside the fence', async (t) => {
  const index = '# Wiki Index\n\n## entities\n\n```\n- [Kod](entities/kod.md)\n- [Yok](entities/yok.md)\n```\n\n- [Ali](entities/ali.md)\n';
  const f = await startServer(t, { files: { 'index.md': index, 'entities/ali.md': page('Ali'), 'entities/kod.md': page('Kod') } });
  const before = await readIndex(f);
  assert.deepEqual(okJson(await call(f.client, 'wiki_update_index', {})), { indexed: 2, added: 1, removed: 0 }, 'fenced entry for an existing page is not linked; fenced entry for a missing page is not removed');
  const { line } = singleInsertion(before, await readIndex(f));
  assert.equal(line, '- [Kod](entities/kod.md)', 'the new entry is outside the fence');
});

test('an unclosed fence at the end of the file is closed before a new category is appended', async (t) => {
  const index = '# Wiki Index\n\n## entities\n\n- [Ali](entities/ali.md)\n\n```\nkod satırı\n';
  const f = await startServer(t, { files: { 'index.md': index, 'entities/ali.md': page('Ali'), 'concepts/c.md': page('Kavram C') } });
  assert.deepEqual(okJson(await call(f.client, 'wiki_update_index', {})), { indexed: 2, added: 1, removed: 0 });
  const after = (await readIndex(f)).toString('utf8');
  assert.ok(after.startsWith(index), 'original bytes are kept as a prefix');
  const suffix = after.slice(index.length).split('\n');
  assert.equal(suffix[0], '```', 'the open fence is closed first');
  assert.ok(suffix.includes('## concepts'), 'the concepts category is appended after the fence');
  assert.ok(suffix.includes('- [Kavram C](concepts/c.md)'), 'the entry is present and outside any fence');
  assert.deepEqual(linkDestinations(after).map((x) => x.dest).sort(), ['concepts/c.md', 'entities/ali.md']);
});

test('an entry above the first heading counts as linked: the page is not listed twice', async (t) => {
  const index = '- [Ali](entities/ali.md) — önce yazıldı\n# Wiki Index\n\n## entities\n\n';
  const f = await startServer(t, { files: { 'index.md': index, 'entities/ali.md': page('Ali') } });
  assert.deepEqual(okJson(await call(f.client, 'wiki_update_index', {})), { indexed: 1, added: 0, removed: 0 });
  assert.equal((await readIndex(f)).toString('utf8'), index);
});

test('a local link with an anchor to an existing page counts as linked (it points to the page)', async (t) => {
  const index = '# Wiki Index\n\n## entities\n\n- [Ali bölümü](entities/ali.md#ozet) — bölüm\n';
  const f = await startServer(t, { files: { 'index.md': index, 'entities/ali.md': page('Ali') } });
  assert.deepEqual(okJson(await call(f.client, 'wiki_update_index', {})), { indexed: 1, added: 0, removed: 0 });
  assert.equal((await readIndex(f)).toString('utf8'), index);
});

test('summary and tags: frontmatter summary (whitespace collapsed) or description, and only word-like tags', async (t) => {
  const f = await startServer(t, { files: {
    'entities/ozet.md': page('Özet Sayfa', 'summary: "Kısa   özet 🙂"\ntags: [ai, "kötü etiket", proje-1]\n'),
    'entities/desc.md': page('Açıklama Sayfa', 'description: "Açıklama metni"\n'),
    'entities/none.md': page('Yalın Sayfa')
  } });
  assert.deepEqual(okJson(await call(f.client, 'wiki_update_index', {})), { indexed: 3, added: 3, removed: 0 });
  const text = (await readIndex(f)).toString('utf8').split('\n');
  assert.ok(text.includes('- [Özet Sayfa](entities/ozet.md) — Kısa özet 🙂 #ai #proje-1'), 'summary collapsed; invalid tag dropped');
  assert.ok(text.includes('- [Açıklama Sayfa](entities/desc.md) — Açıklama metni'), 'description used when no summary');
  assert.ok(text.includes('- [Yalın Sayfa](entities/none.md)'), 'a page with no summary gets a bare entry');
});

test('a secret-shaped summary blocks the index write: the hand-edited index and the Wiki tree stay byte-identical', async (t) => {
  const index = '# Wiki Index\n\n## entities\n\n- [Ali](entities/ali.md) — elle yazıldı\n';
  const f = await startServer(t, { files: { 'index.md': index, 'entities/ali.md': page('Ali'), 'entities/gizli.md': page('Gizli', `summary: "${SECRET_OPENAI}"\n`) } });
  const before = await snapshot(f.wiki);
  const message = refused(await call(f.client, 'wiki_update_index', {}), 'E_SECRET_DETECTED');
  assert.ok(!message.includes(SECRET_OPENAI), 'the matched value is not returned');
  assert.deepEqual(await snapshot(f.wiki), before, 'nothing is written, not even the log');
});

test('a symlinked page is never indexed, and the count ignores it', async (t) => {
  const f = await startServer(t, { files: { 'entities/ali.md': page('Ali') } });
  await writeFile(join(f.dir, 'outside.md'), page('Dış Sayfa'));
  await symlink(join(f.dir, 'outside.md'), join(f.wiki, 'entities', 'dis.md'));
  assert.deepEqual(okJson(await call(f.client, 'wiki_update_index', {})), { indexed: 1, added: 1, removed: 0 });
  const text = (await readIndex(f)).toString('utf8');
  assert.ok(!text.includes('dis.md') && !text.includes('Dış Sayfa'), 'the symlinked page is not in the index');
});

test('a wiki/ directory that resolves outside the vault is refused with E_PATH_ESCAPE', async (t) => {
  const f = await startServer(t, { wikiLink: { 'outside.md': page('Dış') } });
  refused(await call(f.client, 'wiki_update_index', {}), 'E_PATH_ESCAPE');
});

test('CRLF index whose last entry is stale and has no final newline: the result is CRLF throughout and ends in CRLF, not a bare CR', async (t) => {
  const index = '# Wiki Index\r\n\r\n## entities\r\n\r\n- [Ali](entities/ali.md)\r\n- [Eski](entities/yok.md)';
  const f = await startServer(t, { files: { 'index.md': index, 'entities/ali.md': page('Ali') } });
  assert.deepEqual(okJson(await call(f.client, 'wiki_update_index', {})), { indexed: 1, added: 0, removed: 1 });
  assert.equal((await readIndex(f)).toString('utf8'), '# Wiki Index\r\n\r\n## entities\r\n\r\n- [Ali](entities/ali.md)\r\n');
});
