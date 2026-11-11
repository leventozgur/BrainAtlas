// SPDX-License-Identifier: MIT
// BA-19 fix1 regressions: wiki_status coverage reads escaped destinations; anchored and query-suffixed entries name their
// page; paths with spaces are written and read as angle-bracket destinations. Real stdio MCP server, temporary vault.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { defaultConfig } from '../../packages/core/src/config/index.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const page = (title, body = 'Gövde.') => `---\ntype: entity\ntitle: ${title}\n---\n${body}\n`;

async function fixture(t, { files = {}, index } = {}) {
  const home = await mkdtemp(resolve(tmpdir(), 'ba19-links-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const vault = resolve(home, 'vault');
  const wiki = resolve(vault, 'wiki');
  await mkdir(wiki, { recursive: true });
  await writeFile(resolve(wiki, 'log.md'), '# Wiki log\n');
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(dirname(resolve(wiki, rel)), { recursive: true });
    await writeFile(resolve(wiki, rel), text);
  }
  if (index !== undefined) await writeFile(resolve(wiki, 'index.md'), index);
  const config = defaultConfig('lite');
  config.vault.path = vault;
  config.readOnly = false;
  const configFile = resolve(home, 'config.json');
  await writeFile(configFile, JSON.stringify(config));
  const transport = new StdioClientTransport({
    command: process.execPath, args: [resolve(root, 'packages/mcp/bin/brainatlas-mcp.mjs')], cwd: root,
    env: { HOME: home, BRAINATLAS_CONFIG: configFile, BRAINATLAS_VAULT: vault, PATH: process.env.PATH ?? '' }, stderr: 'pipe'
  });
  const client = new Client({ name: 'ba19-links-test', version: '1.0.0' });
  await client.connect(transport);
  t.after(async () => { await client.close(); });
  const indexPath = resolve(wiki, 'index.md');
  return { client, indexPath, readIndex: () => readFile(indexPath, 'utf8') };
}

async function ok(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
}

// ---------------------------------------------------------------- wiki_status coverage

test('BA19-STATUS1: coverage counts a page as indexed when its escaped destination is in a hand-written index (1 of 3 = 33)', async (t) => {
  const index = '# Wiki Index\n\n## entities\n\n- [A](entities/a\\(b\\).md)\n';
  const f = await fixture(t, { files: { 'entities/a(b).md': page('A'), 'entities/a)b.md': page('B'), 'entities/c.md': page('C') }, index });
  const status = await ok(f.client, 'wiki_status');
  assert.equal(status.pageCount, 3);
  assert.equal(status.indexCoveragePct, 33);
});

test('BA19-STATUS2: after wiki_update_index on a fresh vault, coverage is 100 and wiki_status keeps its other fields', async (t) => {
  const f = await fixture(t, { files: { 'entities/a(b).md': page('A'), 'entities/c)d.md': page('C'), 'root.md': page('R') } });
  await ok(f.client, 'wiki_update_index');
  const status = await ok(f.client, 'wiki_status');
  assert.equal(status.indexCoveragePct, 100);
  assert.equal(status.pageCount, 3);
  assert.deepEqual(Object.keys(status).sort(), ['indexAgeMs', 'indexCoveragePct', 'okfErrorCount', 'okfWarningCount', 'pageCount', 'readOnly'].sort());
  assert.equal(status.readOnly, false);
});

// ---------------------------------------------------------------- anchors and query strings name their page

test('BA19-ANCHOR1: an entry with #fragment or ?query to an existing page counts as linked; no duplicate line is added', async (t) => {
  const index = '# Wiki Index\n\n## entities\n\n- [Ali bölümü](entities/ali.md#ozet) — bölüm\n- [Ali sorgu](entities/ali.md?v=2) — sorgu\n';
  const f = await fixture(t, { files: { 'entities/ali.md': page('Ali') }, index });
  assert.deepEqual(await ok(f.client, 'wiki_update_index'), { indexed: 1, added: 0, removed: 0 });
  assert.equal(await f.readIndex(), index);
});

test('BA19-ANCHOR2: an entry whose page is gone is removed even with a #fragment; an anchor-only link is kept', async (t) => {
  const index = '# Wiki Index\n\n## entities\n\n- [Eski](entities/gone.md#x) — eski\n- [Bölüm](#bolum) — çapa\n- [A](entities/a.md#s)\n';
  const f = await fixture(t, { files: { 'entities/a.md': page('A') }, index });
  assert.deepEqual(await ok(f.client, 'wiki_update_index'), { indexed: 1, added: 0, removed: 1 });
  assert.equal(await f.readIndex(), '# Wiki Index\n\n## entities\n\n- [Bölüm](#bolum) — çapa\n- [A](entities/a.md#s)\n');
});

// ---------------------------------------------------------------- paths with spaces: angle-bracket destinations

test('BA19-ANGLE1: a fresh index writes a spaced path in angle brackets (parentheses still escaped inside); three runs add nothing', async (t) => {
  const f = await fixture(t, { files: { 'entities/my note.md': page('My Note'), 'entities/a (b).md': page('Paren Space') } });
  assert.deepEqual(await ok(f.client, 'wiki_update_index'), { indexed: 2, added: 2, removed: 0 });
  const first = await f.readIndex();
  assert.ok(first.includes('- [My Note](<entities/my note.md>)\n'), first);
  assert.ok(first.includes('- [Paren Space](<entities/a \\(b\\).md>)\n'), first);
  for (let run = 2; run <= 3; run++) {
    assert.deepEqual(await ok(f.client, 'wiki_update_index'), { indexed: 2, added: 0, removed: 0 }, `run ${run}`);
    assert.equal(await f.readIndex(), first, `run ${run} changed the bytes`);
  }
});

test('BA19-ANGLE2: a hand-written angle-bracket entry counts as linked; a stale angle entry is removed', async (t) => {
  const index = '# Wiki Index\n\n## entities\n\n- [My Note](<entities/my note.md>) — elle\n- [Eski](<entities/eski sayfa.md>)\n';
  const f = await fixture(t, { files: { 'entities/my note.md': page('My Note') }, index });
  assert.deepEqual(await ok(f.client, 'wiki_update_index'), { indexed: 1, added: 0, removed: 1 });
  assert.equal(await f.readIndex(), '# Wiki Index\n\n## entities\n\n- [My Note](<entities/my note.md>) — elle\n');
});

test('BA19-ANGLE3: wiki_create_entity on an index that already has a spaced entry inserts its line and keeps the angle entry', async (t) => {
  const index = '# Wiki Index\n\n## entities\n\n- [My Note](<entities/my note.md>)\n';
  const f = await fixture(t, { files: { 'entities/my note.md': page('My Note') }, index });
  await ok(f.client, 'wiki_create_entity', { name: 'Yeni Varlik', content: 'Gövde.' });
  assert.equal(await f.readIndex(), '# Wiki Index\n\n## entities\n\n- [My Note](<entities/my note.md>)\n- [Yeni Varlik](entities/yeni-varlik.md)\n');
});

// ---------------------------------------------------------------- fix2: unsafe names are never indexed

test('BA19-UNSAFE1: a page whose name has a line feed or U+2028 is not written to the index and is not counted in coverage; a tab name is kept', async (t) => {
  const f = await fixture(t, { files: { 'entities/nl\nname.md': page('Satır'), 'entities/ls name.md': page('Ayraç'), 'entities/tab\tname.md': page('Sekme'), 'entities/ok.md': page('Tamam') } });
  assert.deepEqual(await ok(f.client, 'wiki_update_index'), { indexed: 4, added: 2, removed: 0 });
  const first = await f.readIndex();
  assert.ok(first.includes('](<entities/tab\tname.md>)'), 'the tab name is written in angle brackets');
  assert.ok(!first.includes('nl\nname') && !first.includes(' '), 'unsafe names never reach the index');
  assert.equal(first.split('\n').filter((line) => line.startsWith('- [')).length, 2);
  assert.deepEqual(await ok(f.client, 'wiki_update_index'), { indexed: 4, added: 0, removed: 0 });
  assert.equal(await f.readIndex(), first, 'idempotent');
  // Pages stay listed; coverage counts only the two indexable pages, both linked: 100.
  assert.equal((await ok(f.client, 'wiki_status')).indexCoveragePct, 100);
  assert.equal((await ok(f.client, 'wiki_status')).pageCount, 4);
});

test('BA19-UNSAFE2: a wiki/ directory outside the vault answers indexCoveragePct 100 (empty-Wiki view)', async (t) => {
  const home = await mkdtemp(resolve(tmpdir(), 'ba19-links-out-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const vault = resolve(home, 'vault');
  const outside = resolve(home, 'outside');
  await mkdir(vault, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(resolve(outside, 'x.md'), page('Dış'));
  await symlink(outside, resolve(vault, 'wiki'));
  const config = defaultConfig('lite');
  config.vault.path = vault;
  config.readOnly = false;
  const configFile = resolve(home, 'config.json');
  await writeFile(configFile, JSON.stringify(config));
  const transport = new StdioClientTransport({
    command: process.execPath, args: [resolve(root, 'packages/mcp/bin/brainatlas-mcp.mjs')], cwd: root,
    env: { HOME: home, BRAINATLAS_CONFIG: configFile, BRAINATLAS_VAULT: vault, PATH: process.env.PATH ?? '' }, stderr: 'pipe'
  });
  const client = new Client({ name: 'ba19-links-out', version: '1.0.0' });
  await client.connect(transport);
  t.after(async () => { await client.close(); });
  assert.equal((await ok(client, 'wiki_status')).indexCoveragePct, 100);
});

test('BA19-UNSAFE3: a control character other than a line break (U+0001) is indexed in angle brackets and reads back; U+0085 is excluded', async (t) => {
  const f = await fixture(t, { files: { 'entities/ctl\u0001name.md': page('Kontrol'), 'entities/nel\u0085name.md': page('Nel'), 'entities/ok.md': page('Tamam') } });
  assert.deepEqual(await ok(f.client, 'wiki_update_index'), { indexed: 3, added: 2, removed: 0 });
  const first = await f.readIndex();
  assert.ok(first.includes('](<entities/ctl\u0001name.md>)'), 'the control character is written inside angle brackets');
  assert.ok(!first.includes('\u0085'), 'U+0085 never reaches the index');
  assert.deepEqual(await ok(f.client, 'wiki_update_index'), { indexed: 3, added: 0, removed: 0 });
  assert.equal(await f.readIndex(), first, 'idempotent');
  assert.equal((await ok(f.client, 'wiki_status')).indexCoveragePct, 100);
});
