// SPDX-License-Identifier: MIT
// BA-20 independent acceptance (blind): docs/contracts/mcp-tools.md matches behavior for the BA-20 rules. The contract text
// is read as the specification; each behavior claim below is checked through the real stdio server.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { call, okJson, startServer, readIndexText, entryLines, ROOT } from './harness.mjs';

const OPTS = { timeout: 60_000 };
const CONTRACT = join(ROOT, 'docs/contracts/mcp-tools.md');
const page = (frontmatter) => `---\n${frontmatter}\n---\nGövde.\n`;

test('contract text states the BA-20 rules (angle brackets for C0/C1/DEL, line-safe labels, empty-slug refusal)', OPTS, async () => {
  const text = await readFile(CONTRACT, 'utf8');
  assert.match(text, /C0, C1 and DEL/, 'control characters rule is written');
  assert.match(text, /CR, LF, U\+0085, U\+2028 and U\+2029/, 'line-break list is written');
  assert.match(text, /E_INVALID_INPUT/, 'empty slug refusal is written');
  assert.match(text, /empty slug/, 'empty slug is named');
});

test('wiki_create_entity inserts only its own line under the matching category and leaves stale lines untouched', OPTS, async (t) => {
  const index = '# Wiki Index\n\n## Entities\n\n- [Gone](entities/gone.md)\n- [Ali](entities/ali.md)\n';
  const f = await startServer(t, { files: { 'entities/ali.md': page('title: Ali'), 'index.md': index } });
  const before = await readIndexText(f);
  okJson(await call(f.client, 'wiki_create_entity', { name: 'Veli Yeni', content: page('title: Veli Yeni') }));
  const after = await readIndexText(f);
  const b = before.split('\n');
  const a = after.split('\n');
  assert.equal(a.length, b.length + 1, 'exactly one line added');
  assert.ok(a.includes('- [Gone](entities/gone.md)'), 'stale entry kept for wiki_update_index');
  const added = a.filter((l) => !b.includes(l));
  assert.equal(added.length, 1);
  assert.ok(added[0].startsWith('- [Veli Yeni](entities/veli-yeni.md)'), `new line is ${JSON.stringify(added[0])}`);
  const start = a.findIndex((l) => l.toLowerCase() === '## entities');
  const next = a.findIndex((l, i) => i > start && l.startsWith('## '));
  const section = a.slice(start + 1, next === -1 ? a.length : next);
  assert.ok(section.includes(added[0]), 'line sits under the Entities category');
});

test('wiki_create_entity line for a page with summary and tags equals the wiki_update_index line for the same page', OPTS, async (t) => {
  const content = page('title: Kısa Özet\nsummary: Düz özet 🚀\ntags: [alfa]');
  const created = await startServer(t, {});
  okJson(await call(created.client, 'wiki_create_entity', { name: 'Kısa Özet', content }));
  const fromCreate = entryLines(await readIndexText(created));
  const scanned = await startServer(t, { files: { 'entities/k-sa-zet.md': content } });
  okJson(await call(scanned.client, 'wiki_update_index', {}));
  const fromUpdate = entryLines(await readIndexText(scanned));
  assert.equal(fromUpdate.length, 1);
  assert.deepEqual(fromCreate, fromUpdate, `create line ${JSON.stringify(fromCreate)} vs update line ${JSON.stringify(fromUpdate)}`);
});
