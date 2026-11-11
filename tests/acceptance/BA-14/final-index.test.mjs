// SPDX-License-Identifier: MIT
// BA-14 final verification of wiki_update_index: parenthesis names are idempotent over repeated runs, lines inside
// fenced code blocks are opaque (closed ``` / ~~~ fences, a 4-backtick fence, an open fence at end of file), and
// pages at the Wiki root join the `## Pages` category. Real stdio server, temporary vault, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startServer, call, okJson } from './harness.mjs';

const page = (frontmatter, body = 'Gövde.') => `---\n${frontmatter}\n---\n${body}\n`;
const EMPTY_INDEX = '# Wiki Index\n\n';
const escapeParens = (path) => path.replace(/([()])/g, '\\$1');
const indexOf = async (f) => readFile(join(f.wiki, 'index.md'));
const lineIndex = (lines, exact) => lines.findIndex((line) => line === exact);

/** Every line of `survivors` appears in `lines`, in the same order (exact string equality). */
function isSubsequence(survivors, lines) {
  let at = 0;
  for (const line of lines) if (at < survivors.length && line === survivors[at]) at++;
  return at === survivors.length;
}

// ---------------------------------------------------------------- parenthesis names: idempotency over three runs

const PAREN_PAGES = {
  'entities/a(b).md': page('title: Parantez B'),
  'entities/a(b)(c).md': page('title: Çift Parantez'),
  'entities/a)b.md': page('title: Kapanış Parantezi'),
  'concepts/t(x).md': page('title: Başlık (özel) [köşeli]')
};

test('PAREN1: four parenthesis-named pages are listed once each; runs two and three add nothing and keep the bytes', async (t) => {
  const f = await startServer(t, { files: { ...PAREN_PAGES, 'index.md': EMPTY_INDEX } });
  assert.deepEqual(okJson(await call(f.client, 'wiki_update_index')), { indexed: 4, added: 4, removed: 0 });
  const afterFirst = await indexOf(f);
  for (let run = 2; run <= 3; run++) {
    assert.deepEqual(okJson(await call(f.client, 'wiki_update_index')), { indexed: 4, added: 0, removed: 0 }, `run ${run}`);
    assert.deepEqual(await indexOf(f), afterFirst, `run ${run} changed the bytes`);
  }
  const out = afterFirst.toString('utf8');
  for (const path of Object.keys(PAREN_PAGES)) {
    assert.equal(out.split(`](${escapeParens(path)})`).length - 1, 1, `${path} must have exactly one escaped entry line`);
  }
  assert.equal(out.split('\n').filter((line) => line.startsWith('- [')).length, 4);
});

// PM update (BA-19, 2026-11-11): fixed — fresh index writes are escaped.
test('PAREN4a (fresh index): with no index file, the first run writes the escaped destination of every parenthesis page (contract example)', async (t) => {
  const f = await startServer(t, { files: { ...PAREN_PAGES } });
  assert.deepEqual(okJson(await call(f.client, 'wiki_update_index')), { indexed: 4, added: 4, removed: 0 });
  const out = (await indexOf(f)).toString('utf8');
  for (const path of Object.keys(PAREN_PAGES)) {
    assert.equal(out.split(`](${escapeParens(path)})`).length - 1, 1, `${path}: fresh index must write the escaped destination once`);
  }
});

// PM update (BA-19, 2026-11-11): fixed — fresh index writes are escaped.
test('PAREN4b (fresh index): with no index file, runs two and three add nothing and keep the bytes', async (t) => {
  const f = await startServer(t, { files: { ...PAREN_PAGES } });
  assert.deepEqual(okJson(await call(f.client, 'wiki_update_index')), { indexed: 4, added: 4, removed: 0 });
  const afterFirst = await indexOf(f);
  for (let run = 2; run <= 3; run++) {
    assert.deepEqual(okJson(await call(f.client, 'wiki_update_index')), { indexed: 4, added: 0, removed: 0 }, `run ${run} must not list pages again`);
    assert.deepEqual(await indexOf(f), afterFirst, `run ${run} changed the bytes`);
  }
});

test('PAREN2: balanced unescaped parentheses in a hand-written entry count as its destination; the page is not listed twice', async (t) => {
  const index = '# Wiki Index\n\n## entities\n\n- [Parantez](entities/a(b).md) — elle yazıldı\n';
  const f = await startServer(t, { files: { 'entities/a(b).md': page('title: Parantez B'), 'index.md': index } });
  assert.deepEqual(okJson(await call(f.client, 'wiki_update_index')), { indexed: 1, added: 0, removed: 0 });
  assert.equal(await readFile(join(f.wiki, 'index.md'), 'utf8'), index);
});

test('PAREN3: a stale balanced-parenthesis entry is removed; an escaped entry for an existing page is kept', async (t) => {
  const index = '# Wiki Index\n\n## entities\n\n- [Kaçış](entities/a\\(b\\).md) — kaçışlı\n- [Eski](entities/gone(x).md)\n';
  const f = await startServer(t, { files: { 'entities/a(b).md': page('title: Parantez B'), 'index.md': index } });
  assert.deepEqual(okJson(await call(f.client, 'wiki_update_index')), { indexed: 1, added: 0, removed: 1 });
  assert.equal(await readFile(join(f.wiki, 'index.md'), 'utf8'), '# Wiki Index\n\n## entities\n\n- [Kaçış](entities/a\\(b\\).md) — kaçışlı\n');
});

test('ANCHOR1: anchor links (#section) are never removed; a stale local entry beside them is removed', async (t) => {
  const index = '# Wiki Index\n\n## entities\n\n- [Bölüm](#bolum) — çapa\n- [Eski](entities/gone.md) — eski\n- [A](entities/a.md)\n';
  const f = await startServer(t, { files: { 'entities/a.md': page('title: A'), 'index.md': index } });
  assert.deepEqual(okJson(await call(f.client, 'wiki_update_index')), { indexed: 1, added: 0, removed: 1 });
  assert.equal(await readFile(join(f.wiki, 'index.md'), 'utf8'), '# Wiki Index\n\n## entities\n\n- [Bölüm](#bolum) — çapa\n- [A](entities/a.md)\n');
});

// ---------------------------------------------------------------- fenced code blocks are opaque

for (const fence of ['```', '~~~']) {
  test(`FENCE1 (${fence}): entry and heading lines inside a closed fence are not links, headings or insertion points`, async (t) => {
    const block = [fence, '- [Fence](entities/gone.md)', '## concepts', '- [Fence2](concepts/k.md)', fence];
    const index = ['# Wiki Index', '', '## entities', '', '- [A](entities/a.md)', '', ...block, ''].join('\n');
    const f = await startServer(t, {
      files: { 'entities/a.md': page('title: A'), 'entities/new.md': page('title: Yeni'), 'concepts/k.md': page('title: K'), 'index.md': index }
    });
    assert.deepEqual(okJson(await call(f.client, 'wiki_update_index')), { indexed: 3, added: 2, removed: 0 });
    const out = await readFile(join(f.wiki, 'index.md'), 'utf8');
    const lines = out.split('\n');
    assert.ok(isSubsequence(index.split('\n'), lines), 'every original line must survive in order, including the fenced stale entry');
    const closing = lines.lastIndexOf(fence);
    assert.ok(lineIndex(lines, '- [Yeni](entities/new.md)') < lineIndex(lines, fence), 'new entities line goes above the fence, under the real heading');
    assert.ok(lines.lastIndexOf('## concepts') > closing, 'a new ## concepts heading is appended after the closed fence');
    assert.ok(lines.includes('- [K](concepts/k.md)') && lines.indexOf('- [K](concepts/k.md)') > closing);
    assert.deepEqual(okJson(await call(f.client, 'wiki_update_index')), { indexed: 3, added: 0, removed: 0 });
    assert.equal(await readFile(join(f.wiki, 'index.md'), 'utf8'), out, 'second run must not change bytes');
  });
}

test('FENCE2: an open fence at end of file keeps its lines; the new category block closes the fence first', async (t) => {
  const index = ['# Wiki Index', '', '## entities', '', '- [A](entities/a.md)', '', '```', '- [Old](entities/old.md)', ''].join('\n');
  const f = await startServer(t, {
    files: { 'entities/a.md': page('title: A'), 'entities/old.md': page('title: Eski'), 'concepts/k.md': page('title: K'), 'index.md': index }
  });
  assert.deepEqual(okJson(await call(f.client, 'wiki_update_index')), { indexed: 3, added: 2, removed: 0 });
  const out = await readFile(join(f.wiki, 'index.md'), 'utf8');
  const lines = out.split('\n');
  assert.ok(isSubsequence(index.split('\n'), lines), 'the fenced entry line and the open fence survive in order');
  const closers = lines.map((line, i) => (line === '```' ? i : -1)).filter((i) => i >= 0);
  assert.equal(closers.length, 2, 'the open fence is closed by an added fence line');
  assert.ok(lines.indexOf('## concepts') > closers[1], 'the new ## concepts heading sits after the closing fence');
  assert.deepEqual(okJson(await call(f.client, 'wiki_update_index')), { indexed: 3, added: 0, removed: 0 });
  assert.equal(await readFile(join(f.wiki, 'index.md'), 'utf8'), out);
});

test('FENCE3: a four-backtick fence is not closed by a three-backtick line inside it; the entry inside stays opaque', async (t) => {
  const index = ['# Wiki Index', '', '## entities', '', '````', '```', '- [Fence](entities/gone.md)', '````', ''].join('\n');
  const f = await startServer(t, { files: { 'entities/a.md': page('title: A'), 'index.md': index } });
  assert.deepEqual(okJson(await call(f.client, 'wiki_update_index')), { indexed: 1, added: 1, removed: 0 });
  const out = await readFile(join(f.wiki, 'index.md'), 'utf8');
  assert.ok(isSubsequence(index.split('\n'), out.split('\n')), 'fenced stale entry must not be removed');
});

// ---------------------------------------------------------------- root pages join the `## Pages` category

test('ROOT1: a Wiki-root page in a fresh index is listed under ## Pages', async (t) => {
  const f = await startServer(t, { files: { 'notiz.md': page('title: Notiz'), 'entities/a.md': page('title: A') } });
  assert.deepEqual(okJson(await call(f.client, 'wiki_update_index')), { indexed: 2, added: 2, removed: 0 });
  const lines = (await readFile(join(f.wiki, 'index.md'), 'utf8')).split('\n');
  const at = lines.indexOf('## Pages');
  assert.ok(at >= 0, '## Pages heading present');
  assert.equal(lines.slice(at + 1).find((line) => line !== ''), '- [Notiz](notiz.md)');
});

test('ROOT2: an existing index without a Pages heading gets ## Pages appended at the end, with the root entry under it', async (t) => {
  const f = await startServer(t, { files: { 'notiz.md': page('title: Notiz'), 'entities/a.md': page('title: A'), 'index.md': '# Wiki Index\n\n## entities\n\n- [A](entities/a.md)\n' } });
  assert.deepEqual(okJson(await call(f.client, 'wiki_update_index')), { indexed: 2, added: 1, removed: 0 });
  assert.equal(await readFile(join(f.wiki, 'index.md'), 'utf8'), '# Wiki Index\n\n## entities\n\n- [A](entities/a.md)\n\n## Pages\n\n- [Notiz](notiz.md)\n');
});

test('ROOT3: a lower-case ## pages heading receives the root page below its existing entry; no second Pages heading', async (t) => {
  const index = '# Wiki Index\n\n## pages\n\n- [Eski](eski.md)\n';
  const f = await startServer(t, { files: { 'eski.md': page('title: Eski'), 'yeni.md': page('title: Yeni'), 'index.md': index } });
  assert.deepEqual(okJson(await call(f.client, 'wiki_update_index')), { indexed: 2, added: 1, removed: 0 });
  assert.equal(await readFile(join(f.wiki, 'index.md'), 'utf8'), '# Wiki Index\n\n## pages\n\n- [Eski](eski.md)\n- [Yeni](yeni.md)\n');
});
