// SPDX-License-Identifier: MIT
// BA-21: pageSlug transliterates Turkish and accented Latin letters to ASCII before the vendored slugify, and the
// create tools use it end to end (page path + index line). Real stdio MCP server via the BA-20 harness.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pageSlug } from '../../packages/mcp/src/slug.mjs';
import {
  call,
  okJson,
  refused,
  startServer,
  snapshot,
  readIndexText,
  entryLines,
} from '../acceptance/BA-20/harness.mjs';

const CASES = [
  ['Deneme Varlık', 'deneme-varlik'],
  ['Çağrı Merkezi', 'cagri-merkezi'],
  ['Ağrı Merkezi', 'agri-merkezi'],
  ['İzmir Deposu', 'izmir-deposu'],
  ['IŞIK', 'isik'],
  ['ğüşıöç', 'gusioc'],
  ['ğüşıöç !!!', 'gusioc'],
  ['Ö', 'o'],
  ['ğ 42', 'g-42'],
  ['Café Crème', 'cafe-creme'],
  ['Ñandú', 'nandu'],
  ['naïve résumé', 'naive-resume'],
  ['C\u0327ay', 'cay'],
  ['\ufb01le', 'file'],
  ['Straße', 'stra-e'],
  ['Rapor.v2', 'rapor'],
  ['Yeni Varlik', 'yeni-varlik'],
  ['日本語 ✨', ''],
  ['   ', ''],
  ['...-_', ''],
  ['!!! ---', ''],
];

test('BA21-SLUG1: pageSlug covers the transliteration table', () => {
  for (const [name, expected] of CASES) assert.equal(pageSlug(name), expected, JSON.stringify(name));
});

test('BA21-SLUG2: pageSlug keeps extension stripping and lowercasing', () => {
  assert.equal(pageSlug('Deneme Varlık.md'), 'deneme-varlik');
  assert.equal(pageSlug('IŞIK.TXT'), 'isik');
});

test('BA21-SLUG3: create entity uses the transliterated slug and index line', async (t) => {
  const f = await startServer(t, {});
  assert.deepEqual(
    okJson(
      await call(f.client, 'wiki_create', { type: 'entity', name: 'Deneme Varlık', content: '---\ntitle: x\n---\nG\n' })
    ),
    { path: 'wiki/entities/deneme-varlik.md', created: true }
  );
  assert.deepEqual(entryLines(await readIndexText(f)), ['- [Deneme Varlık](entities/deneme-varlik.md)']);
});

test('BA21-SLUG4: create concept uses the same rule; Çağrı and Ağrı are distinct pages', async (t) => {
  const f = await startServer(t, {});
  assert.deepEqual(
    okJson(
      await call(f.client, 'wiki_create', { type: 'concept', name: 'ğüşıöç', content: '---\ntitle: x\n---\nG\n' })
    ),
    { path: 'wiki/concepts/gusioc.md', created: true }
  );
  const cagri = okJson(
    await call(f.client, 'wiki_create', { type: 'entity', name: 'Çağrı Merkezi', content: '---\ntitle: x\n---\nG\n' })
  );
  const agri = okJson(
    await call(f.client, 'wiki_create', { type: 'entity', name: 'Ağrı Merkezi', content: '---\ntitle: x\n---\nG\n' })
  );
  assert.equal(cagri.path, 'wiki/entities/cagri-merkezi.md');
  assert.equal(agri.path, 'wiki/entities/agri-merkezi.md');
  // A different name that maps to the same slug is refused as an existing page.
  refused(
    await call(f.client, 'wiki_create', { type: 'entity', name: 'Çagri Merkezi', content: '---\ntitle: x\n---\nG\n' }),
    'E_ALREADY_EXISTS'
  );
});

test('BA21-SLUG5: a name with no letter or digit after transliteration is still refused and writes nothing', async (t) => {
  const f = await startServer(t, {});
  const before = await snapshot(f.vault);
  refused(
    await call(f.client, 'wiki_create', { type: 'entity', name: '日本語 ✨', content: '---\ntitle: x\n---\nG\n' }),
    'E_INVALID_INPUT'
  );
  assert.deepEqual(await snapshot(f.vault), before, 'refusal writes nothing');
  assert.equal(pageSlug('日本語 ✨'), '');
});
