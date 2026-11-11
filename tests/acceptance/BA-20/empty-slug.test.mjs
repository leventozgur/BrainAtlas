// SPDX-License-Identifier: MIT
// BA-20 independent acceptance (blind): a name with no ASCII letter or digit is refused with E_INVALID_INPUT, the refusal
// text does not echo the input, and nothing (page, index, log) is written. Names with Turkish letters that still contain
// ASCII letters are created; their slugs are reported as diagnostics.
import test from 'node:test';
import assert from 'node:assert/strict';
import { call, okJson, refused, startServer, snapshot, readIndexText, entryLines } from './harness.mjs';

const OPTS = { timeout: 60_000 };
const EMPTY_NAMES = ['ğüşıöç !!!', '   ', '...-_', '日本語 ✨', 'Ö'];

for (const name of EMPTY_NAMES) {
  test(`empty slug ${JSON.stringify(name)} on a fresh vault: E_INVALID_INPUT, no value echoed, vault bytes unchanged`, OPTS, async (t) => {
    const f = await startServer(t, {});
    const before = await snapshot(f.vault);
    const text = refused(await call(f.client, 'wiki_create_entity', { name, content: '---\ntitle: x\n---\nG\n' }), 'E_INVALID_INPUT');
    assert.equal(text.includes(name.trim()) && name.trim().length > 0, false, 'error text does not echo the name');
    assert.equal(await snapshot(f.vault).then((after) => JSON.stringify(after) === JSON.stringify(before)), true, 'no file written');
    const concept = refused(await call(f.client, 'wiki_create_concept', { name, content: '---\ntitle: x\n---\nG\n' }), 'E_INVALID_INPUT');
    assert.equal(concept.includes(name.trim()) && name.trim().length > 0, false, 'concept refusal does not echo the name');
    assert.deepEqual(await snapshot(f.vault), before, 'concept refusal writes nothing');
    assert.equal(Object.keys(before).some((k) => k.includes('.md')), false, 'fixture is empty');
  });
}

test('empty slug refused with an existing index and log: index and log bytes unchanged, no hidden page', OPTS, async (t) => {
  const f = await startServer(t, { files: { 'entities/ali.md': '---\ntitle: Ali\n---\nG\n' } });
  okJson(await call(f.client, 'wiki_update_index', {}));
  const before = await snapshot(f.vault);
  refused(await call(f.client, 'wiki_create_entity', { name: 'ğüşıöç !!!', content: '---\ntitle: x\n---\nG\n' }), 'E_INVALID_INPUT');
  const after = await snapshot(f.vault);
  assert.deepEqual(after, before, 'vault bytes unchanged (index, log and pages)');
  assert.equal(Object.keys(after).some((k) => /(^|\/)\.md$/.test(k)), false, 'no entities/.md');
  const pages = okJson(await call(f.client, 'wiki_list_pages', {})).pages;
  assert.deepEqual(pages, ['wiki/entities/ali.md']);
});

test('valid names still work after a refusal, and ASCII digits make a valid slug', OPTS, async (t) => {
  const f = await startServer(t, {});
  refused(await call(f.client, 'wiki_create_entity', { name: 'ğüşıöç', content: '---\ntitle: x\n---\nG\n' }), 'E_INVALID_INPUT');
  const ok = okJson(await call(f.client, 'wiki_create_entity', { name: 'ğ 42', content: '---\ntitle: x\n---\nG\n' }));
  assert.equal(ok.created, true);
  assert.equal(ok.path, 'wiki/entities/42.md');
  assert.deepEqual(entryLines(await readIndexText(f)), ['- [ğ 42](entities/42.md)']);
});

test('Turkish names: slugs reported; names with ASCII letters are created', OPTS, async (t) => {
  const f = await startServer(t, {});
  const cagri = okJson(await call(f.client, 'wiki_create_entity', { name: 'Çağrı Merkezi', content: '---\ntitle: x\n---\nG\n' }));
  const izmir = okJson(await call(f.client, 'wiki_create_entity', { name: 'İzmir Deposu', content: '---\ntitle: x\n---\nG\n' }));
  t.diagnostic(`"Çağrı Merkezi" -> ${cagri.path}`);
  t.diagnostic(`"İzmir Deposu" -> ${izmir.path}`);
  assert.equal(cagri.created, true);
  assert.equal(izmir.created, true);
  const collision = await call(f.client, 'wiki_create_entity', { name: 'Ağrı Merkezi', content: '---\ntitle: x\n---\nG\n' });
  t.diagnostic(`"Ağrı Merkezi" (distinct name, same slug as "Çağrı Merkezi") -> ${collision.isError ? 'refused' : 'created'}`);
});
