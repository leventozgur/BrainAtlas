// SPDX-License-Identifier: MIT
// BA-20: wiki_create_entity / wiki_create_concept take the frontmatter of the content as the page's own frontmatter
// (summary, description, tags) and build the index line from it, so the create line equals the wiki_update_index line.
// Real stdio MCP server, temporary HOME and vault, no network.
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
const CONTENT = '---\ntitle: Kısa Özet\nsummary: Düz özet\ntags: [alfa]\n---\nGövde.\n';

async function fixture(t, { files = {} } = {}) {
  const home = await mkdtemp(resolve(tmpdir(), 'ba20-cfm-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const vault = resolve(home, 'vault');
  const wiki = resolve(vault, 'wiki');
  await mkdir(wiki, { recursive: true });
  await writeFile(resolve(wiki, 'log.md'), '# Wiki log\n');
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(dirname(resolve(wiki, rel)), { recursive: true });
    await writeFile(resolve(wiki, rel), text);
  }
  const config = defaultConfig('lite');
  config.vault.path = vault;
  config.readOnly = false;
  const configFile = resolve(home, 'config.json');
  await writeFile(configFile, JSON.stringify(config));
  const transport = new StdioClientTransport({
    command: process.execPath, args: [resolve(root, 'packages/mcp/bin/brainatlas-mcp.mjs')], cwd: root,
    env: { HOME: home, BRAINATLAS_CONFIG: configFile, BRAINATLAS_VAULT: vault, PATH: process.env.PATH ?? '' }, stderr: 'pipe'
  });
  const client = new Client({ name: 'ba20-cfm-test', version: '1.0.0' });
  await client.connect(transport);
  t.after(async () => { await client.close(); });
  return { wiki, client };
}

async function ok(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
}

const entryLines = (text) => text.split('\n').filter((line) => line.startsWith('- ['));

test('BA20-CFM1: create writes the content frontmatter as page frontmatter, not as body text', async (t) => {
  const f = await fixture(t);
  await ok(f.client, 'wiki_create_entity', { name: 'Kısa Özet', content: CONTENT });
  const written = await readFile(resolve(f.wiki, 'entities/k-sa-zet.md'), 'utf8');
  assert.match(written, /^summary: Düz özet$/m);
  assert.match(written, /^tags:\n  - alfa$/m);
  assert.match(written, /^title: Kısa Özet$/m, 'the title is the create name');
  assert.equal(written.split('\n---\n').length, 2, 'exactly one frontmatter block');
  assert.ok(written.endsWith('Gövde.\n'));
});

test('BA20-CFM2: the create line for a page with summary and tags equals the wiki_update_index line for the same page', async (t) => {
  const created = await fixture(t);
  await ok(created.client, 'wiki_create_entity', { name: 'Kısa Özet', content: CONTENT });
  const fromCreate = entryLines(await readFile(resolve(created.wiki, 'index.md'), 'utf8'));
  const scanned = await fixture(t, { files: { 'entities/k-sa-zet.md': CONTENT } });
  await ok(scanned.client, 'wiki_update_index');
  const fromUpdate = entryLines(await readFile(resolve(scanned.wiki, 'index.md'), 'utf8'));
  assert.equal(fromUpdate.length, 1);
  assert.deepEqual(fromCreate, fromUpdate);
  assert.ok(fromCreate[0].includes(' — Düz özet #alfa'), `summary and tag expected, got ${JSON.stringify(fromCreate[0])}`);
});

test('BA20-CFM3: create content without frontmatter keeps the body and gets the name as title', async (t) => {
  const f = await fixture(t);
  await ok(f.client, 'wiki_create_concept', { name: 'Düz Kavram', content: 'Sadece gövde.\n' });
  const written = await readFile(resolve(f.wiki, 'concepts/d-z-kavram.md'), 'utf8');
  assert.match(written, /^title: Düz Kavram$/m);
  assert.ok(written.endsWith('Sadece gövde.\n'));
  assert.deepEqual(entryLines(await readFile(resolve(f.wiki, 'index.md'), 'utf8')), ['- [Düz Kavram](concepts/d-z-kavram.md)']);
});
