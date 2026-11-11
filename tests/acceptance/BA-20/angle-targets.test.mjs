// SPDX-License-Identifier: MIT
// BA-20 independent acceptance (blind): page names with C0, DEL, C1 or a space are written as angle-bracket
// destinations, read back exactly, are covered by wiki_status, and three wiki_update_index runs are idempotent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { call, okJson, textOf, startServer, readIndexText, entryLines } from './harness.mjs';

const OPTS = { timeout: 60_000 };
const page = (title) => `---\ntitle: ${title}\n---\nKısa gövde.\n`;
const hex = (ch) => `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`;

const CASES = [
  ['U+0001 (C0)', '\u0001'],
  ['U+001F (C0 upper)', '\u001f'],
  ['U+007F (DEL)', '\u007f'],
  ['U+0080 (C1 lower)', '\u0080'],
  ['U+009B (C1 CSI)', '\u009b'],
  ['U+009F (C1 upper)', '\u009f'],
  ['U+0020 (space)', ' ']
];

for (const [label, ch] of CASES) {
  test(`page name with ${label}: angle-bracket destination, exact read-back, idempotent, coverage 100`, OPTS, async (t) => {
    const path = `entities/c${ch}d.md`;
    const f = await startServer(t, { files: { [path]: page('Kontrol'), 'entities/normal.md': page('Normal') } });
    const first = okJson(await call(f.client, 'wiki_update_index', {}));
    assert.equal(first.added, 2, 'both pages get an entry');
    const text1 = await readIndexText(f);
    const expected = `- [Kontrol](<entities/c${ch}d.md>)`;
    const hits = entryLines(text1).filter((line) => line.includes('d.md'));
    assert.equal(hits.length, 1, 'exactly one entry line for the special-name page');
    assert.equal(hits[0], expected, `entry line must be an angle-bracket destination (${hex(ch)} or space inside <...>)`);
    assert.ok(entryLines(text1).includes('- [Normal](entities/normal.md)'), 'ordinary page keeps its plain entry');
    const read = okJson(await call(f.client, 'wiki_read_index', {}));
    assert.equal(read.content, text1, 'wiki_read_index returns the same bytes as the file');
    assert.ok(read.content.includes(expected), 'wiki_read_index returns the same entry line');
    assert.equal(okJson(await call(f.client, 'wiki_status', {})).indexCoveragePct, 100, 'coverage counts the special-name page');
    for (let run = 2; run <= 3; run++) {
      const again = okJson(await call(f.client, 'wiki_update_index', {}));
      assert.equal(again.added, 0, `run ${run} adds nothing`);
      assert.equal(again.removed, 0, `run ${run} removes nothing`);
      assert.equal(await readIndexText(f), text1, `run ${run} keeps the bytes`);
    }
  });
}

test('page name with a space and an existing plain-linked page: space form is bracketed, plain form untouched', OPTS, async (t) => {
  const f = await startServer(t, { files: { 'entities/my note.md': page('Not'), 'entities/plain.md': page('Düz') } });
  okJson(await call(f.client, 'wiki_update_index', {}));
  const lines = entryLines(await readIndexText(f));
  assert.ok(lines.includes('- [Not](<entities/my note.md>)'), 'space path is an angle-bracket destination');
  assert.ok(lines.includes('- [Düz](entities/plain.md)'), 'plain path stays a plain destination');
});
