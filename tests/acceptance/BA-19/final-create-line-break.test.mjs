// SPDX-License-Identifier: MIT
// BA-19 final verification (independent, blind): wiki_create_entity / wiki_create_concept with a name that holds a line
// break. The page path comes from slugify, so no line break can reach the index. Behaviour is recorded per case.
import test from 'node:test';
import assert from 'node:assert/strict';
import { call, okJson, textOf, startServer, readIndex, singleInsertion } from './harness.mjs';
import { linkedPages } from './retest-reader.mjs';

const BREAKS = ['\r', '\n', '\u0085', ' ', ' '];
const hex = (ch) => `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`;

for (const ch of BREAKS) {
  test(`create entity named "Satir${hex(ch)}Sonu": the slug holds no break, the index gets exactly one line, runs stay idempotent`, async (t) => {
    const f = await startServer(t, { files: { 'entities/onceki.md': '---\ntitle: Önceki\n---\nGövde.\n' } });
    okJson(await call(f.client, 'wiki_update_index', {}));
    const before = await readIndex(f);
    const created = okJson(await call(f.client, 'wiki_create_entity', { name: `Satir${ch}Sonu`, content: 'Gövde.\n' }));
    assert.equal(created.path, 'wiki/entities/satir-sonu.md');
    const after = await readIndex(f);
    const inserted = singleInsertion(before, after);
    assert.ok(inserted.line.includes('](entities/satir-sonu.md)'));
    assert.ok(!/[\r\u2028\u2029]/.test(after.toString('utf8')), 'no CR, U+2028 or U+2029 anywhere in the index (LF is the line separator itself)');
    assert.ok(!inserted.line.slice(inserted.line.indexOf('](')).includes(ch), 'the link destination holds no line-breaking character');
    assert.ok(linkedPages(after.toString('utf8')).has('entities/satir-sonu.md'));
    const page = okJson(await call(f.client, 'wiki_read_page', { path: 'entities/satir-sonu.md' }));
    assert.ok(page !== null);
    const again = okJson(await call(f.client, 'wiki_update_index', {}));
    assert.equal(again.added, 0);
    assert.deepEqual(await readIndex(f), after, 'the next index run keeps the bytes');
  });
}

test('create concept named with CR and U+2028 between words: the slug is the words joined by hyphens, one index line', async (t) => {
  const f = await startServer(t, {});
  const created = okJson(await call(f.client, 'wiki_create_concept', { name: 'Birinci\r\nIkinci Ucuncu', content: 'Gövde.\n' }));
  assert.equal(created.path, 'wiki/concepts/birinci-ikinci-ucuncu.md');
  const text = (await readIndex(f)).toString('utf8');
  assert.ok(!text.includes('\r') && !text.includes(' '));
  assert.equal(text.split('\n').filter((line) => line.includes('](concepts/')).length, 1);
});

test('create with a name that slugifies to nothing (only a line break): observed behaviour, the index stays valid and break-free', async (t) => {
  const f = await startServer(t, {});
  const res = await call(f.client, 'wiki_create_entity', { name: ' ', content: 'Gövde.\n' });
  const text = (await readIndex(f)).toString('utf8');
  assert.ok(!text.includes(' '), 'no line break reaches the index in either outcome');
  if (res.isError) {
    t.diagnostic(`refused: ${textOf(res)}`);
    assert.equal(text, '', 'a refusal writes no index');
  } else {
    const created = JSON.parse(textOf(res));
    t.diagnostic(`created at path: ${created.path}`);
    assert.ok(linkedPages(text).has(created.path.slice('wiki/'.length)), 'the index links the created page');
  }
});

// Observation, not a contract rule: the contract restricts line breaks in PATHS. The title is the raw create name and
// is whitespace-collapsed only where JavaScript \s applies (U+0085 is not in \s), so U+0085 can reach the link text.
test('create entity whose name holds U+0085 in the title: the index entry is still one line that reads back (title reported)', async (t) => {
  const f = await startServer(t, { files: { 'entities/onceki.md': '---\ntitle: Önceki\n---\nGövde.\n' } });
  okJson(await call(f.client, 'wiki_update_index', {}));
  const before = await readIndex(f);
  okJson(await call(f.client, 'wiki_create_entity', { name: 'Satir\u0085Sonu', content: 'Gövde.\n' }));
  const after = await readIndex(f);
  const inserted = singleInsertion(before, after);
  assert.ok(linkedPages(after.toString('utf8')).has('entities/satir-sonu.md'));
  t.diagnostic(`link text holds U+0085: ${inserted.line.includes('\u0085')}`);
});
