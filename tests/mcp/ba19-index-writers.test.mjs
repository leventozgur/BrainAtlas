// SPDX-License-Identifier: MIT
// BA-19: every index write (wiki_create_entity, wiki_create_concept, wiki_update_index) uses the same minimal edit and
// escaping rules. Real stdio MCP server, temporary HOME and vault, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { defaultConfig } from '../../packages/core/src/config/index.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const page = (title, body = 'Gövde.') => `---\ntype: entity\ntitle: ${title}\n---\n${body}\n`;
const escapeParens = (path) => path.replace(/([()\\])/g, '\\$1');

/** Starts a stdio server for a fresh vault. `files` maps wiki-relative paths to text; `index` is optional. */
async function fixture(t, { files = {}, index } = {}) {
  const home = await mkdtemp(resolve(tmpdir(), 'ba19-index-'));
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
  const client = new Client({ name: 'ba19-index-test', version: '1.0.0' });
  await client.connect(transport);
  t.after(async () => { await client.close(); });
  const indexPath = resolve(wiki, 'index.md');
  return { wiki, client, indexPath, readIndex: () => readFile(indexPath, 'utf8') };
}

/** Calls a tool and returns its JSON payload; a refusal fails the test with the refusal text. */
async function ok(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
}

// ---------------------------------------------------------------- create tools keep a hand-edited index

const HAND_EDITED = [
  '# Wiki Index',
  '',
  'Elle yazılmış giriş paragrafı.',
  '',
  '> Not satırı.',
  '',
  '## entities',
  '',
  '- [Sample One](entities/sample-01.md) — Elle yazılmış özet #manuel',
  '- [Silinmiş](entities/gone.md) — artık yok',
  'Serbest satır (giriş değil).',
  '',
  '## Özel Bölüm',
  '',
  'Metin.',
  ''
].join('\n');

// The new entity line goes after the last entry of ## entities; every other line is kept as it was.
const HAND_EDITED_AFTER_CREATE = HAND_EDITED.replace(
  '- [Silinmiş](entities/gone.md) — artık yok\n',
  '- [Silinmiş](entities/gone.md) — artık yok\n- [Yeni Varlik](entities/yeni-varlik.md)\n'
);

const FILES = { 'entities/sample-01.md': page('Sample One') };

test('BA19-CREATE1: wiki_create_entity keeps a hand-edited index byte for byte and adds its line under ## entities', async (t) => {
  const f = await fixture(t, { files: FILES, index: HAND_EDITED });
  assert.deepEqual(await ok(f.client, 'wiki_create_entity', { name: 'Yeni Varlik', content: 'Gövde.' }), { path: 'wiki/entities/yeni-varlik.md', created: true });
  assert.equal(await f.readIndex(), HAND_EDITED_AFTER_CREATE);
});

test('BA19-CREATE2: the same on a CRLF index keeps every line ending and gives the new line CRLF', async (t) => {
  const f = await fixture(t, { files: FILES, index: HAND_EDITED.replace(/\n/g, '\r\n') });
  await ok(f.client, 'wiki_create_entity', { name: 'Yeni Varlik', content: 'Gövde.' });
  assert.equal(await f.readIndex(), HAND_EDITED_AFTER_CREATE.replace(/\n/g, '\r\n'));
});

test('BA19-CREATE3: wiki_create_concept adds its line under the existing lower-case ## concepts heading; no second heading', async (t) => {
  const index = '# Wiki Index\n\nGiriş notu.\n\n## concepts\n\n- [K](concepts/k.md) — kalıcı #kavram\n\nSon not.\n';
  const f = await fixture(t, { files: { 'concepts/k.md': page('K') }, index });
  await ok(f.client, 'wiki_create_concept', { name: 'Yeni Kavram', content: 'Gövde.' });
  assert.equal(await f.readIndex(),
    '# Wiki Index\n\nGiriş notu.\n\n## concepts\n\n- [K](concepts/k.md) — kalıcı #kavram\n- [Yeni Kavram](concepts/yeni-kavram.md)\n\nSon not.\n');
});

test('BA19-CREATE4: wiki_create_entity without an index file writes a fresh index under ## entities (folder rule)', async (t) => {
  const f = await fixture(t, { files: FILES });
  await ok(f.client, 'wiki_create_entity', { name: 'Yeni Varlik', content: 'Gövde.' });
  assert.equal(await f.readIndex(), '# Wiki Index\n\n## entities\n\n- [Yeni Varlik](entities/yeni-varlik.md)\n');
});

// ---------------------------------------------------------------- fresh index escapes parentheses

const PAREN_PAGES = {
  'entities/a)b.md': page('Kapanış Parantezi'),
  'entities/a(b)(c).md': page('Çift Parantez'),
  'concepts/t(x).md': page('Başlık (özel)')
};

test('BA19-FRESH1: wiki_update_index without an index writes escaped destinations; a broken ")" name is one line; runs two and three change nothing', async (t) => {
  const f = await fixture(t, { files: PAREN_PAGES });
  assert.deepEqual(await ok(f.client, 'wiki_update_index'), { indexed: 3, added: 3, removed: 0 });
  const first = await f.readIndex();
  for (const path of Object.keys(PAREN_PAGES)) {
    assert.equal(first.split(`](${escapeParens(path)})`).length - 1, 1, `${path} must have exactly one escaped entry`);
  }
  assert.equal(first.split('\n').filter((line) => line.startsWith('- [')).length, 3);
  for (let run = 2; run <= 3; run++) {
    assert.deepEqual(await ok(f.client, 'wiki_update_index'), { indexed: 3, added: 0, removed: 0 }, `run ${run}`);
    assert.equal(await f.readIndex(), first, `run ${run} changed the bytes`);
  }
});

test('BA19-FRESH2: a page created after a fresh parenthesis index is appended under its folder; the earlier lines keep their bytes', async (t) => {
  const f = await fixture(t, { files: PAREN_PAGES });
  await ok(f.client, 'wiki_update_index');
  const before = await f.readIndex();
  await ok(f.client, 'wiki_create_entity', { name: 'Yeni Varlik', content: 'Gövde.' });
  const after = await f.readIndex();
  // Every earlier line survives in order; the only addition is the new entity line.
  const kept = before.split('\n');
  const lines = after.split('\n');
  let at = 0;
  for (const line of lines) if (at < kept.length && line === kept[at]) at++;
  assert.equal(at, kept.length, 'an earlier line changed or moved');
  assert.equal(lines.length, kept.length + 1, 'exactly one line is added');
  assert.ok(after.includes('- [Yeni Varlik](entities/yeni-varlik.md)\n'));
  assert.equal(after.split('](entities/yeni-varlik.md)').length - 1, 1);
});
