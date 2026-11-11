// SPDX-License-Identifier: MIT
// BA-20 independent acceptance (blind): index entry labels (title) and summaries are line-safe. CR, LF, U+0085, U+2028,
// U+2029 and other control characters become one space; empty labels fall back to the file name; Turkish letters and
// emoji are kept; wiki_create_entity and wiki_update_index follow the same rule.
import test from 'node:test';
import assert from 'node:assert/strict';
import { call, okJson, startServer, readIndexText, entryLines, CONTROL_RE } from './harness.mjs';

const OPTS = { timeout: 60_000 };
const page = (frontmatter) => `---\n${frontmatter}\n---\nGövde.\n`;

test('disk titles with U+2028, U+2029 and U+0085 become single spaces; the page is one entry line', OPTS, async (t) => {
  const f = await startServer(t, { files: { 'entities/title-breaks.md': page('title: "Ab Cd\u0085Ef Gh"') } });
  okJson(await call(f.client, 'wiki_update_index', {}));
  const lines = entryLines(await readIndexText(f));
  assert.deepEqual(lines, ['- [Ab Cd Ef Gh](entities/title-breaks.md)']);
});

test('summary with CR, U+0085, U+2028, U+2029, DEL, C1 and tab is one line with single spaces', OPTS, async (t) => {
  const f = await startServer(t, { files: { 'entities/sum-disk.md': page('title: Sum Disk\nsummary: "a\rb\u0085c d e\u007ff\u009bg\th"') } });
  okJson(await call(f.client, 'wiki_update_index', {}));
  const text = await readIndexText(f);
  assert.deepEqual(entryLines(text), ['- [Sum Disk](entities/sum-disk.md) — a b c d e f g h']);
  assert.equal(text.split('\n').filter((l) => l.includes('sum-disk')).length, 1, 'the page is not split across lines');
});

test('Turkish letters and emoji survive in title and summary', OPTS, async (t) => {
  const f = await startServer(t, { files: { 'entities/emoji.md': page('title: "Özet 🚀 Tamam"\nsummary: Türkçe özet ✅') } });
  okJson(await call(f.client, 'wiki_update_index', {}));
  assert.deepEqual(entryLines(await readIndexText(f)), ['- [Özet 🚀 Tamam](entities/emoji.md) — Türkçe özet ✅']);
});

test('title that is empty after normalization falls back to the file name without .md', OPTS, async (t) => {
  const f = await startServer(t, { files: {
    'entities/nl-title.md': page('title: "\u0085 "'),
    'entities/ws-title.md': page('title: "   "')
  } });
  okJson(await call(f.client, 'wiki_update_index', {}));
  const lines = entryLines(await readIndexText(f));
  assert.ok(lines.includes('- [nl-title](entities/nl-title.md)'), `got ${JSON.stringify(lines)}`);
  assert.ok(lines.includes('- [ws-title](entities/ws-title.md)'), `got ${JSON.stringify(lines)}`);
});

test('file name with C0 and empty title: label is the normalized file name, path stays angle-bracketed', OPTS, async (t) => {
  const f = await startServer(t, { files: { 'entities/e\u0001f.md': page('title: "\u0085 "') } });
  okJson(await call(f.client, 'wiki_update_index', {}));
  const lines = entryLines(await readIndexText(f));
  assert.deepEqual(lines, ['- [e f](<entities/e\u0001f.md>)']);
});

test('wiki_create_entity name with CR, LF, U+0085, U+2028, U+2029, C0 and C1 gives one label with single spaces', OPTS, async (t) => {
  const f = await startServer(t, {});
  const name = 'Satır\r\nBir\u0085Üç Dört Beş\u0001Altı\u009bYedi';
  okJson(await call(f.client, 'wiki_create_entity', { name, content: page('title: x') }));
  const text = await readIndexText(f);
  const lines = entryLines(text);
  assert.equal(lines.length, 1, 'one entry line');
  assert.match(lines[0], /^- \[Satır Bir Üç Dört Beş Altı Yedi\]\(entities\/[^\s()]+\.md\)$/);
  assert.equal(text.split('\n').filter((l) => l.includes('Yedi')).length, 1, 'the label is not split');
  assert.equal(CONTROL_RE.test(lines[0]), false, 'entry line has no control or line-break characters');
});

test('create and update share the rule: same raw label gives the same normalized label on both paths', OPTS, async (t) => {
  const raw = 'X\u0085Y Z W\u009bV\u007fU\tS';
  const created = await startServer(t, {});
  okJson(await call(created.client, 'wiki_create_entity', { name: raw, content: page('title: x') }));
  const fromCreate = entryLines(await readIndexText(created));
  const updated = await startServer(t, { files: { 'entities/parity.md': page(`title: "${raw}"`) } });
  okJson(await call(updated.client, 'wiki_update_index', {}));
  const fromUpdate = entryLines(await readIndexText(updated));
  assert.equal(fromCreate.length, 1);
  assert.equal(fromUpdate.length, 1);
  const labelOf = (line) => line.slice(3, line.indexOf(']('));
  assert.equal(labelOf(fromCreate[0]), 'X Y Z W V U S');
  assert.equal(labelOf(fromUpdate[0]), 'X Y Z W V U S');
});

test('Turkish name with ASCII-free letters is created with its label kept (slug reported, not asserted)', OPTS, async (t) => {
  const f = await startServer(t, {});
  const r = okJson(await call(f.client, 'wiki_create_entity', { name: 'Çağrı Merkezi 🚀', content: page('title: x') }));
  t.diagnostic(`slug path for "Çağrı Merkezi 🚀": ${r.path}`);
  assert.equal(r.created, true);
  assert.deepEqual(entryLines(await readIndexText(f)), [`- [Çağrı Merkezi 🚀](${r.path.replace(/^wiki\//, '')})`]);
});
