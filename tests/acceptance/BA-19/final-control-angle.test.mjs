// SPDX-License-Identifier: MIT
// BA-19 final verification (independent, blind): page names with control characters other than the line breaks are
// written inside angle brackets, read back exactly, are counted by coverage, and three runs are idempotent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { call, okJson, startServer, readIndex } from './harness.mjs';
import { linkedPages } from './retest-reader.mjs';

const page = (title) => `---\ntitle: ${title}\n---\nKısa gövde.\n`;
const CONTROLS = [
  ['U+0001', '\u0001'],
  ['U+001F', '\u001f'],
  ['U+007F DEL', '\u007f'],
  ['U+009B CSI (C1 control)', '\u009b']
];
const hex = (ch) => `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`;

for (const [label, ch] of CONTROLS) {
  // PM update (BA-20, 2026-11-11): C1 controls are bracketed now.
  test(`${label} in a page name: written as an angle-bracket destination, reads back exactly, three runs idempotent, coverage 100`, async (t) => {
    const path = `entities/c${ch}d.md`;
    const f = await startServer(t, { files: { [path]: page('Kontrol'), 'entities/normal.md': page('Normal') } });
    const first = okJson(await call(f.client, 'wiki_update_index', {}));
    assert.equal(first.added, 2);
    const bytes1 = await readIndex(f);
    const text = bytes1.toString('utf8');
    const lines = text.split('\n').filter((line) => line.includes('d.md'));
    assert.equal(lines.length, 1, 'exactly one entry line for the control-character page');
    assert.ok(lines[0].includes(`](<entities/c${ch}d.md>)`), `${hex(ch)} must be inside angle brackets, got a plain destination`);
    assert.ok(linkedPages(text).has(path), 'the independent reader finds the page with the exact name');
    assert.ok(text.includes(ch), 'the character is kept as written (not dropped or replaced)');
    assert.equal(okJson(await call(f.client, 'wiki_status', {})).indexCoveragePct, 100);
    for (let run = 2; run <= 3; run++) {
      const again = okJson(await call(f.client, 'wiki_update_index', {}));
      assert.equal(again.added, 0, `run ${run} adds nothing`);
      assert.deepEqual(await readIndex(f), bytes1, `run ${run} keeps the bytes`);
    }
  });
}

test('control-character names next to ordinary names: all pages are linked, no duplicates, the index is stable', async (t) => {
  const files = { 'entities/normal.md': page('Normal'), 'root.md': page('Kök') };
  for (const [, ch] of CONTROLS) files[`concepts/k${ch}.md`] = page(`K ${hex(ch)}`);
  const f = await startServer(t, { files });
  const first = okJson(await call(f.client, 'wiki_update_index', {}));
  assert.equal(first.added, 6);
  const text = (await readIndex(f)).toString('utf8');
  const linked = linkedPages(text);
  assert.equal(linked.size, 6);
  for (const [, ch] of CONTROLS) assert.ok(linked.has(`concepts/k${ch}.md`), `${hex(ch)} page is linked`);
  const bytes1 = await readIndex(f);
  assert.equal(okJson(await call(f.client, 'wiki_update_index', {})).added, 0);
  assert.deepEqual(await readIndex(f), bytes1);
});

test('a control-character page created through wiki_create_entity is not possible from the name (slugify); the index stays valid', async (t) => {
  const f = await startServer(t, {});
  const created = okJson(await call(f.client, 'wiki_create_entity', { name: 'Ad\u0001Kontrol\u009b', content: 'Gövde.\n' }));
  assert.equal(created.path, 'wiki/entities/ad-kontrol.md', 'every character outside [a-z0-9] becomes a hyphen in the slug');
  const text = (await readIndex(f)).toString('utf8');
  const entry = text.split('\n').find((line) => line.includes('entities/ad-kontrol.md'));
  assert.ok(entry, 'the page has one entry line');
  assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(entry.slice(entry.indexOf(']('))), 'the link destination holds no control character');
  // Observation (not a contract rule): the title is the raw create name, so control characters can appear in the link text.
  t.diagnostic(`title as written in the index link text: ${JSON.stringify(entry.slice(0, entry.indexOf('](')))}`);
  assert.ok(linkedPages(text).has('entities/ad-kontrol.md'));
});
