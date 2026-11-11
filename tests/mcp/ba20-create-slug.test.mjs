// SPDX-License-Identifier: MIT
// BA-20: a create name whose slug is empty (no ASCII letter or digit) is refused with E_INVALID_INPUT, without a fixed
// message that echoes the name, and nothing is written: no hidden `.md` page and no index change. Real stdio MCP
// server, temporary HOME and vault, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { defaultConfig } from '../../packages/core/src/config/index.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const page = (title) => `---\ntype: entity\ntitle: ${title}\n---\nGövde.\n`;

async function fixture(t, { files = {}, index } = {}) {
  const home = await mkdtemp(resolve(tmpdir(), 'ba20-slug-'));
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
  const client = new Client({ name: 'ba20-slug-test', version: '1.0.0' });
  await client.connect(transport);
  t.after(async () => { await client.close(); });
  const indexPath = resolve(wiki, 'index.md');
  return { wiki, client, indexPath, readIndex: () => readFile(indexPath, 'utf8') };
}

async function ok(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
}

async function refused(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, true, `${name} must be refused`);
  const text = result.content[0].text;
  assert.ok(text.startsWith('E_INVALID_INPUT:'), `unexpected refusal: ${text}`);
  return text;
}

/** Names of everything directly inside a Wiki folder (empty when the folder is missing). */
async function listDir(dir) {
  try { return await readdir(dir); } catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
}

test('BA20-SLUG1: wiki_create_entity with a name that has no ASCII letter or digit is refused; no hidden page, no index', async (t) => {
  const f = await fixture(t, {});
  const name = '\u0001\u009b ';
  const text = await refused(f.client, 'wiki_create_entity', { name, content: 'Gövde.\n' });
  assert.ok(!text.includes('\u0001') && !text.includes('\u009b'), 'the refusal does not echo the name');
  assert.deepEqual(await listDir(resolve(f.wiki, 'entities')), [], 'no file in entities/');
  await assert.rejects(readFile(f.indexPath, 'utf8'), { code: 'ENOENT' }, 'no index is written');
});

test('BA20-SLUG2: wiki_create_concept with punctuation only is refused; an existing index keeps its bytes', async (t) => {
  const index = '# Wiki Index\n\n## concepts\n\n- [K](concepts/k.md)\n';
  const f = await fixture(t, { files: { 'concepts/k.md': page('K') }, index });
  await refused(f.client, 'wiki_create_concept', { name: '!!! ---', content: 'Gövde.\n' });
  assert.deepEqual(await listDir(resolve(f.wiki, 'concepts')), ['k.md'], 'only the existing page is in concepts/');
  assert.equal(await f.readIndex(), index);
});

test('BA20-SLUG3: a single dot and a dash-only name are refused the same way', async (t) => {
  const f = await fixture(t, {});
  await refused(f.client, 'wiki_create_entity', { name: '.', content: 'Gövde.\n' });
  await refused(f.client, 'wiki_create_entity', { name: ' - ', content: 'Gövde.\n' });
  assert.deepEqual(await listDir(resolve(f.wiki, 'entities')), []);
});

test('BA20-SLUG4: a name with at least one ASCII letter or digit is still created (control characters are dropped from the slug)', async (t) => {
  const f = await fixture(t, {});
  assert.deepEqual(await ok(f.client, 'wiki_create_entity', { name: 'Ad\u0001', content: 'Gövde.\n' }), { path: 'wiki/entities/ad.md', created: true });
  assert.deepEqual(await listDir(resolve(f.wiki, 'entities')), ['ad.md']);
});
