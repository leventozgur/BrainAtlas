// SPDX-License-Identifier: MIT
// BA-20: angle-bracket destinations cover every C0/C1 control character, DEL and spaces; index labels and summaries
// never carry line breaks or control characters; an empty label falls back to the file name. Real stdio MCP server,
// temporary HOME and vault, no network.
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
// Double-quoted YAML scalar with \u escapes for controls, so line breaks inside a value cannot break the frontmatter.
const yamlQuote = (value) => `"${value.replace(new RegExp('[\\\\"\\x00-\\x1f\\x7f-\\x9f\u2028\u2029]', 'g'), (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`)}"`;
const page = (title, extra = '') => `---\ntype: entity\ntitle: ${yamlQuote(title)}\n${extra}---\nGövde.\n`;
const hex = (ch) => `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
// Every C0 control except the line breaks, every C1 control except U+0085 (a line break for Markdown), and DEL.
const CONTROL_CHARS = [
  ...Array.from({ length: 0x20 - 0x01 }, (_, i) => String.fromCodePoint(0x01 + i)).filter((ch) => ch !== '\n' && ch !== '\r'),
  ...Array.from({ length: 0x9f - 0x7f + 1 }, (_, i) => String.fromCodePoint(0x7f + i)).filter((ch) => ch !== '\u0085')
];

async function fixture(t, { files = {}, index } = {}) {
  const home = await mkdtemp(resolve(tmpdir(), 'ba20-labels-'));
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
  const client = new Client({ name: 'ba20-labels-test', version: '1.0.0' });
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

// ---------------------------------------------------------------- destination: every control character and space

test('BA20-DEST1: each C0/C1 control character, DEL and a space in a page name is written in angle brackets; coverage 100; runs two and three change nothing', async (t) => {
  const names = [' ', ...CONTROL_CHARS];
  const files = {};
  for (const ch of names) files[`entities/k${ch}.md`] = page(`K ${hex(ch)}`);
  const f = await fixture(t, { files });
  assert.deepEqual(await ok(f.client, 'wiki_update_index'), { indexed: names.length, added: names.length, removed: 0 });
  const first = await f.readIndex();
  for (const ch of names) {
    assert.ok(first.includes(`](<entities/k${ch}.md>)`), `${hex(ch)} page must be written in angle brackets`);
  }
  assert.equal((await ok(f.client, 'wiki_status')).indexCoveragePct, 100);
  for (let run = 2; run <= 3; run++) {
    assert.deepEqual(await ok(f.client, 'wiki_update_index'), { indexed: names.length, added: 0, removed: 0 }, `run ${run}`);
    assert.equal(await f.readIndex(), first, `run ${run} keeps the bytes`);
  }
});

test('BA20-DEST2: a C1 control character (U+009B) in a page name is an angle-bracket destination that a create writes too', async (t) => {
  const f = await fixture(t, { files: { 'entities/c\u009bd.md': page('Kontrol') } });
  await ok(f.client, 'wiki_update_index');
  const text = await f.readIndex();
  assert.ok(text.includes('](<entities/c\u009bd.md>)'), 'U+009B must be inside angle brackets');
  assert.equal((await ok(f.client, 'wiki_status')).indexCoveragePct, 100);
});

// ---------------------------------------------------------------- labels: line breaks and controls become one space

test('BA20-LABEL1: a title with CR, LF, U+0085, U+2028, U+2029 and C0/C1 controls is one line with single spaces', async (t) => {
  const title = 'Satır\u2028Kırma\u0085Son\r\nYeni\u0001Ad\u009b';
  const f = await fixture(t, { files: { 'entities/label.md': page(title) } });
  assert.deepEqual(await ok(f.client, 'wiki_update_index'), { indexed: 1, added: 1, removed: 0 });
  const text = await f.readIndex();
  assert.equal(text.match(/[\u0080-\u009f\u2028\u2029\r]/g), null, 'no line break or control character in the index');
  const entries = text.split('\n').filter((line) => line.includes('entities/label.md'));
  assert.deepEqual(entries, ['- [Satır Kırma Son Yeni Ad](entities/label.md)']);
  assert.deepEqual(await ok(f.client, 'wiki_update_index'), { indexed: 1, added: 0, removed: 0 });
});

test('BA20-LABEL2: a summary with U+0085 and U+2029 stays on the entry line with single spaces', async (t) => {
  const f = await fixture(t, { files: { 'entities/summary.md': page('Özet Sayfa', 'summary: "Özet\\u0085satır\\u2029devam"\n') } });
  await ok(f.client, 'wiki_update_index');
  const text = await f.readIndex();
  assert.equal(text.match(/[\u0080-\u009f\u2028\u2029\r]/g), null, 'no line break or control character in the index');
  const entries = text.split('\n').filter((line) => line.includes('entities/summary.md'));
  assert.deepEqual(entries, ['- [Özet Sayfa](entities/summary.md) — Özet satır devam']);
});

test('BA20-LABEL3: a title that is empty after cleaning falls back to the file name without .md', async (t) => {
  const f = await fixture(t, { files: { 'entities/kontrol-ad.md': page('\u0001\u009b \u2028') } });
  assert.deepEqual(await ok(f.client, 'wiki_update_index'), { indexed: 1, added: 1, removed: 0 });
  assert.equal(await f.readIndex(), '# Wiki Index\n\n## entities\n\n- [kontrol-ad](entities/kontrol-ad.md)\n');
});

test('BA20-LABEL4: wiki_create_entity and wiki_create_concept with line breaks in the name write one clean line each', async (t) => {
  const f = await fixture(t, {});
  assert.deepEqual(await ok(f.client, 'wiki_create_entity', { name: 'Yeni\u2028Ad\u0001', content: 'Gövde.\n' }), { path: 'wiki/entities/yeni-ad.md', created: true });
  assert.deepEqual(await ok(f.client, 'wiki_create_concept', { name: 'Kav\u0085ram\r\nSozu', content: 'Gövde.\n' }), { path: 'wiki/concepts/kav-ram-sozu.md', created: true });
  const text = await f.readIndex();
  assert.equal(text.match(/[\u0080-\u009f\u2028\u2029\r]/g), null, 'no line break or control character in the index');
  assert.equal(text.split('\n').filter((line) => line.includes('entities/yeni-ad.md')).length, 1);
  assert.ok(text.includes('- [Yeni Ad](entities/yeni-ad.md)\n'));
  assert.ok(text.includes('- [Kav ram Sozu](concepts/kav-ram-sozu.md)\n'));
});
