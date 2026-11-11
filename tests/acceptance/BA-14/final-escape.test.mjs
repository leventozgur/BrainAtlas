// SPDX-License-Identifier: MIT
// BA-14 final verification (S8): when wiki/ resolves outside the vault, every Wiki tool either refuses with
// E_PATH_ESCAPE or answers as an empty Wiki. No response carries outside content and nothing is written outside.
// A vault root that is itself a symlink stays legitimate. Real stdio server, temporary vault, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm, symlink, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { startServer, call, okJson, refused, textOf, snapshot } from './harness.mjs';

const page = (frontmatter, body = 'Gövde.') => `---\n${frontmatter}\n---\n${body}\n`;
const MARKERS = ['DISWIKI-ZQ', 'DISBODY-ZQ', 'DISIDX-ZQ', 'DISLOG-ZQ', 'DISROOT-ZQ', 'DISDIR-ZQ'];

/** A vault whose wiki/ is a symlink to a directory outside the vault. Every outside file carries markers. */
async function outsideWikiFixture(t) {
  const f = await startServer(t);
  const outsideWiki = join(f.dir, 'outside-wiki');
  await mkdir(join(outsideWiki, 'entities'), { recursive: true });
  await mkdir(join(outsideWiki, 'DISDIR-ZQ'), { recursive: true });
  await writeFile(join(outsideWiki, 'entities', 'dis.md'), page('title: DISWIKI-ZQ\nsummary: "DISBODY-ZQ"', 'DISBODY-ZQ'));
  await writeFile(join(outsideWiki, 'index.md'), '# Wiki Index\n\n- [DISIDX-ZQ](entities/dis.md)\n');
  await writeFile(join(outsideWiki, 'log.md'), 'DISLOG-ZQ\n');
  await writeFile(join(outsideWiki, 'DISROOT-ZQ.md'), page('title: DISROOT-ZQ'));
  await writeFile(join(outsideWiki, 'DISDIR-ZQ', 'x.md'), page('title: DISDIR-ZQ'));
  await rm(f.wiki, { recursive: true, force: true });
  await symlink(outsideWiki, f.wiki);
  return { ...f, outsideWiki };
}

const NEW_PAGE = page('title: Yeni', 'Yeni gövde.');

// One case per Wiki tool. `expect` is either 'refused' (E_PATH_ESCAPE) or a function over the parsed response.
const CASES = [
  ['wiki_query', { query: 'DISBODY' }, (r) => assert.deepEqual(okJson(r).results, [])],
  ['wiki_list_pages', {}, (r) => assert.deepEqual(okJson(r), { pages: [] })],
  ['wiki_status', {}, (r) => assert.equal(okJson(r).pageCount, 0)],
  ['wiki_read_page', { path: 'entities/dis.md' }, 'refused'],
  ['wiki_read_index', {}, 'refused'],
  ['wiki_lint', {}, 'refused'],
  ['wiki_update_index', {}, 'refused'],
  ['wiki_write_page', { path: 'entities/new.md', content: NEW_PAGE }, 'refused'],
  ['wiki_update_page', { path: 'entities/dis.md', patch: { body: 'MARK-WRITE' } }, 'refused'],
  ['wiki_create_entity', { name: 'Yeni Varlik', content: 'Gövde.' }, 'refused'],
  ['wiki_create_concept', { name: 'Yeni Kavram', content: 'Gövde.' }, 'refused'],
  ['wiki_add_crosslinks', { path: 'entities/dis.md' }, 'refused']
];

for (const [name, args, expect] of CASES) {
  test(`S8 ${name}: with wiki/ outside the vault it refuses or answers empty; no outside content; nothing written outside`, async (t) => {
    const f = await outsideWikiFixture(t);
    const outsideBefore = await snapshot(f.outsideWiki);
    const vaultBefore = await snapshot(f.vault);
    const r = await call(f.client, name, args);
    const text = textOf(r);
    for (const marker of MARKERS) assert.equal(text.includes(marker), false, `${name} response leaked ${marker}`);
    if (expect === 'refused') refused(r, 'E_PATH_ESCAPE');
    else {
      assert.notEqual(r.isError, true, `unexpected refusal: ${text}`);
      expect(r);
    }
    assert.deepEqual(await snapshot(f.outsideWiki), outsideBefore, `${name} changed the outside Wiki`);
    assert.deepEqual(await snapshot(f.vault), vaultBefore, `${name} changed the vault`);
  });
}

test('S8 combined: every tool, one server; no response anywhere carries outside markers; outside Wiki and vault unchanged', async (t) => {
  const f = await outsideWikiFixture(t);
  const outsideBefore = await snapshot(f.outsideWiki);
  const vaultBefore = await snapshot(f.vault);
  const texts = [];
  for (const [name, args] of CASES) texts.push(textOf(await call(f.client, name, args)));
  for (const query of ['DISBODY', 'DISIDX', 'DISLOG', 'DISROOT', 'DISDIR', 'DISWIKI']) texts.push(textOf(await call(f.client, 'wiki_query', { query })));
  for (const text of texts) for (const marker of MARKERS) assert.equal(text.includes(marker), false, `a response leaked ${marker}`);
  assert.deepEqual(await snapshot(f.outsideWiki), outsideBefore);
  assert.deepEqual(await snapshot(f.vault), vaultBefore);
});

test('S8 positive control: a vault root that is a symlink to a real vault is legitimate; read tools serve its pages', async (t) => {
  const f = await startServer(t, { files: { 'entities/a.md': page('title: A'), 'index.md': '# Wiki Index\n\n' } });
  await rename(f.vault, join(f.dir, 'realvault'));
  await symlink(join(f.dir, 'realvault'), f.vault);
  assert.deepEqual(okJson(await call(f.client, 'wiki_list_pages', {})), { pages: ['wiki/entities/a.md'] });
  assert.equal(okJson(await call(f.client, 'wiki_status', {})).pageCount, 1);
  assert.match(okJson(await call(f.client, 'wiki_read_index', {})).content, /# Wiki Index/);
  assert.equal(okJson(await call(f.client, 'wiki_read_page', { path: 'entities/a.md' })).truncated, false);
  assert.deepEqual(okJson(await call(f.client, 'wiki_update_index', {})), { indexed: 1, added: 1, removed: 0 });
});
