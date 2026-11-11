// SPDX-License-Identifier: MIT
// BA-14 blind acceptance: wiki_update_page patch validation and valid patch behavior over stdio MCP.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import matter from 'gray-matter';
import { startServer, call, okJson, refused, textOf, snapshot, logCount } from './harness.mjs';

const PAGE_PATH = 'entities/p.md';
const PAGE = '---\ntype: entity\ntitle: Patch Sayfası\nstatus: active\n---\nEski gövde 🧪\n';

async function fixture(t) {
  return startServer(t, { files: { [PAGE_PATH]: PAGE } });
}
async function readParsed(f) {
  return matter(await readFile(join(f.wiki, PAGE_PATH), 'utf8'));
}

test('invalid patch shapes are refused with E_INVALID_INPUT; file and log unchanged; message never echoes values', async (t) => {
  const f = await fixture(t);
  const cases = [
    ['unknown key', { title: 'MARK-TITLE-1' }],
    ['unknown key beside valid keys', { body: 'MARK-BODY-2', extra: 'MARK-EXTRA-3' }],
    ['frontmatter array', { frontmatter: ['MARK-ARR-4'] }],
    ['frontmatter null', { frontmatter: null }],
    ['frontmatter string', { frontmatter: 'MARK-STR-5' }],
    ['frontmatter number', { frontmatter: 7 }],
    ['body number', { body: 8 }],
    ['body null', { body: null }],
    ['body object', { body: { x: 'MARK-BODY-OBJ-9' } }],
    ['append number', { append: 9 }],
    ['append object', { append: { x: 'MARK-APP-OBJ-10' } }]
  ];
  for (const [label, patch] of cases) {
    const before = await snapshot(f.vault);
    const logBefore = await logCount(f.wiki, 'update-page');
    const r = await call(f.client, 'wiki_update_page', { path: PAGE_PATH, patch });
    refused(r, 'E_INVALID_INPUT');
    assert.equal(/MARK-/.test(textOf(r)), false, `${label}: error text echoes the caller value`);
    assert.deepEqual(await snapshot(f.vault), before, `${label}: file or log changed`);
    assert.equal(await logCount(f.wiki, 'update-page'), logBefore, `${label}: log changed`);
  }
});

test('invalid patch next to content is still refused (patch is validated even when content wins)', async (t) => {
  const f = await fixture(t);
  const before = await snapshot(f.vault);
  const r = await call(f.client, 'wiki_update_page', { path: PAGE_PATH, content: '---\ntitle: Yeni\n---\nYeni\n', patch: { title: 'MARK-CT-11' } });
  refused(r, 'E_INVALID_INPUT');
  assert.equal(/MARK-/.test(textOf(r)), false);
  assert.deepEqual(await snapshot(f.vault), before);
});

test('valid frontmatter patch merges into existing frontmatter and keeps the body', async (t) => {
  const f = await fixture(t);
  const logBefore = await logCount(f.wiki, 'update-page');
  assert.deepEqual(okJson(await call(f.client, 'wiki_update_page', { path: PAGE_PATH, patch: { frontmatter: { status: 'confirmed', tags: ['x'] } } })), { path: 'wiki/entities/p.md', updated: true });
  const parsed = await readParsed(f);
  assert.equal(parsed.data.status, 'confirmed');
  assert.equal(parsed.data.title, 'Patch Sayfası', 'untouched frontmatter key survives');
  assert.deepEqual(parsed.data.tags, ['x']);
  assert.equal(parsed.content.trim(), 'Eski gövde 🧪');
  assert.equal(await logCount(f.wiki, 'update-page'), logBefore + 1);
});

test('valid body patch replaces the body and keeps frontmatter', async (t) => {
  const f = await fixture(t);
  assert.equal(okJson(await call(f.client, 'wiki_update_page', { path: PAGE_PATH, patch: { body: 'Yeni gövde' } })).updated, true);
  const parsed = await readParsed(f);
  assert.equal(parsed.content.trim(), 'Yeni gövde');
  assert.equal(parsed.data.title, 'Patch Sayfası');
});

test('valid append patch adds text to the end of the body', async (t) => {
  const f = await fixture(t);
  assert.equal(okJson(await call(f.client, 'wiki_update_page', { path: PAGE_PATH, patch: { append: '\nEk satır' } })).updated, true);
  assert.equal((await readParsed(f)).content.trim(), 'Eski gövde 🧪\nEk satır');
});

test('frontmatter and body together, and frontmatter and append together', async (t) => {
  const f = await fixture(t);
  assert.equal(okJson(await call(f.client, 'wiki_update_page', { path: PAGE_PATH, patch: { frontmatter: { status: 'superseded' }, body: 'Birlikte' } })).updated, true);
  let parsed = await readParsed(f);
  assert.equal(parsed.data.status, 'superseded');
  assert.equal(parsed.content.trim(), 'Birlikte');
  assert.equal(okJson(await call(f.client, 'wiki_update_page', { path: PAGE_PATH, patch: { frontmatter: { status: 'active' }, append: '\nSon' } })).updated, true);
  parsed = await readParsed(f);
  assert.equal(parsed.data.status, 'active');
  assert.equal(parsed.content.trim(), 'Birlikte\nSon');
});

test('body and append together: append is not silently dropped', async (t) => {
  const f = await fixture(t);
  const r = await call(f.client, 'wiki_update_page', { path: PAGE_PATH, patch: { body: 'GOVDE-X', append: '\nEKLE-Y' } });
  if (r.isError) {
    refused(r, 'E_INVALID_INPUT');
    assert.equal((await readParsed(f)).content.trim(), 'Eski gövde 🧪', 'refusal must leave the page unchanged');
    return;
  }
  assert.equal(okJson(r).updated, true);
  const body = (await readParsed(f)).content;
  assert.ok(body.includes('GOVDE-X') && body.includes('EKLE-Y'), `append was reported as applied but body is ${JSON.stringify(body.trim())}`);
});

test('empty patch object is accepted and leaves content semantically unchanged', async (t) => {
  const f = await fixture(t);
  assert.equal(okJson(await call(f.client, 'wiki_update_page', { path: PAGE_PATH, patch: {} })).updated, true);
  const parsed = await readParsed(f);
  assert.equal(parsed.data.title, 'Patch Sayfası');
  assert.equal(parsed.content.trim(), 'Eski gövde 🧪');
});

test('content takes precedence over a valid patch, as documented', async (t) => {
  const f = await fixture(t);
  assert.equal(okJson(await call(f.client, 'wiki_update_page', { path: PAGE_PATH, content: '---\ntitle: İçerik\n---\nİçerik gövdesi\n', patch: { append: '\nYOKSAY' } })).updated, true);
  const parsed = await readParsed(f);
  assert.equal(parsed.data.title, 'İçerik');
  assert.equal(parsed.content.trim(), 'İçerik gövdesi');
});

test('neither content nor patch is still an input error and writes nothing', async (t) => {
  const f = await fixture(t);
  const before = await snapshot(f.vault);
  refused(await call(f.client, 'wiki_update_page', { path: PAGE_PATH }), 'E_INVALID_INPUT');
  assert.deepEqual(await snapshot(f.vault), before);
});
