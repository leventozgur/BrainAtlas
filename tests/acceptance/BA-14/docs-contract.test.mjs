// SPDX-License-Identifier: MIT
// BA-14 blind acceptance: docs/contracts/mcp-tools.md must agree with the advertised tool schemas and the behavior.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT, startServer, call, okJson, refused, snapshot } from './harness.mjs';

const doc = await readFile(join(ROOT, 'docs/contracts/mcp-tools.md'), 'utf8');

test('contract text names the BA-14 rules: patch whitelist, E_INVALID_INPUT, return fields, minimal index edit', () => {
  assert.match(doc, /`patch`[^\n]*accepts only the keys `frontmatter`[^\n]*`body`[^\n]*`append`/);
  assert.match(doc, /returns `E_INVALID_INPUT`/);
  assert.match(doc, /nothing is written and nothing is logged/);
  assert.match(doc, /`content` takes precedence, but `patch` is still validated/);
  assert.match(doc, /`wiki_update_index` returns `\{indexed, added, removed\}`/);
  assert.match(doc, /every existing line is kept byte for byte/);
  assert.match(doc, /a missing category is appended at the end of the file/);
  assert.match(doc, /The content is scanned for secrets before the write/);
});

test('tool input keys in the contract match the advertised inputSchema of every tool', async (t) => {
  const f = await startServer(t);
  const listed = Object.fromEntries((await f.client.listTools()).tools.map((tool) => [tool.name, Object.keys(tool.inputSchema?.properties ?? {}).sort()]));
  const schemaLine = doc.match(/Tool schemas are: (.+?)\.\n/s);
  assert.ok(schemaLine, 'schema summary line is present');
  const declared = [...schemaLine[1].matchAll(/`(wiki_\w+)\{([^}]*)\}`/g)];
  assert.ok(declared.length >= 12, `expected all tools in the contract, found ${declared.length}`);
  for (const [, name, body] of declared) {
    const keys = body.split(',').map((part) => part.trim()).filter(Boolean).map((part) => part.replace(/\?.*$/, '').split(':')[0]).sort();
    assert.deepEqual(listed[name], keys, `${name} keys differ between contract and tool list`);
  }
});

test('advertised wiki_update_index description does not promise a full rebuild', async (t) => {
  const f = await startServer(t);
  const tool = (await f.client.listTools()).tools.find((x) => x.name === 'wiki_update_index');
  assert.ok(tool, 'wiki_update_index is advertised');
  assert.doesNotMatch(tool.description, /rebuild/i, `advertised description says "${tool.description}" but the contract says minimal edit`);
});

test('contract example: update_index return shape has exactly the three documented fields', async (t) => {
  const f = await startServer(t, { files: { 'entities/a.md': '---\ntitle: A\n---\nA.\n', 'index.md': '# Wiki Index\n\n## entities\n\n' } });
  const r = okJson(await call(f.client, 'wiki_update_index'));
  assert.deepEqual(Object.keys(r).sort(), ['added', 'indexed', 'removed']);
});

test('contract claim: refused patch leaves no trace in files or log', async (t) => {
  const f = await startServer(t, { files: { 'entities/a.md': '---\ntitle: A\n---\nA.\n' } });
  const before = await snapshot(f.vault);
  refused(await call(f.client, 'wiki_update_page', { path: 'entities/a.md', patch: { nope: 'x' } }), 'E_INVALID_INPUT');
  assert.deepEqual(await snapshot(f.vault), before);
});
