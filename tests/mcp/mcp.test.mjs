// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { defaultConfig } from '../../packages/core/src/config/index.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const writeTools = ['wiki_write_page', 'wiki_update_page', 'wiki_create_entity', 'wiki_create_concept', 'wiki_add_crosslinks', 'wiki_update_index'];
async function setup(readOnly = false) {
  const home = await mkdtemp(resolve(tmpdir(), 'brainatlas-mcp-'));
  const vault = resolve(home, 'vault');
  await cp(resolve(root, 'demo-vault'), vault, { recursive: true });
  const config = defaultConfig('lite'); config.readOnly = readOnly; config.vault.path = vault;
  const configFile = resolve(home, 'config.json');
  await writeFile(configFile, JSON.stringify(config));
  return { home, vault, configFile };
}
async function connect(env) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve(root, 'packages/mcp/bin/brainatlas-mcp.mjs')], cwd: root,
    env: { HOME: env.home, BRAINATLAS_CONFIG: env.configFile, BRAINATLAS_VAULT: env.vault, PATH: process.env.PATH ?? '' }, stderr: 'pipe' });
  const client = new Client({ name: 'mcp-contract-test', version: '1.0.0' });
  await client.connect(transport);
  return { client, transport };
}
function payload(result) {
  const text = result.content.find((item) => item.type === 'text')?.text;
  try { return JSON.parse(text); } catch { return text; }
}
async function invoke(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, `${name}: ${result.content?.[0]?.text ?? 'tool call failed'}`);
  return payload(result);
}

test('stdio MCP exposes and exercises every tool with scoped writes', async (t) => {
  const env = await setup(); t.after(async () => rm(env.home, { recursive: true, force: true }));
  const { client, transport } = await connect(env); t.after(async () => { await client.close(); await transport.close(); });
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map((item) => item.name).sort(), ['wiki_add_crosslinks', 'wiki_create_concept', 'wiki_create_entity', 'wiki_lint', 'wiki_list_pages', 'wiki_query', 'wiki_read_index', 'wiki_read_page', 'wiki_status', 'wiki_update_index', 'wiki_update_page', 'wiki_write_page'].sort());

  assert.equal((await invoke(client, 'wiki_query', { query: 'synthetic evidence', limit: 2 })).abstained, false);
  const readPage = await client.callTool({ name: 'wiki_read_page', arguments: { path: 'entities/sample-01.md' } });
  assert.equal(readPage.isError, undefined, JSON.stringify(readPage));
  assert.match(payload(readPage).content, /Synthetic bilingual/);
  assert.match(payload(await client.callTool({ name: 'wiki_read_index', arguments: {} })).content, /Wiki index/);
  assert.ok(payload(await client.callTool({ name: 'wiki_list_pages', arguments: { type: 'entities' } })).pages.length > 0);
  assert.equal(payload(await client.callTool({ name: 'wiki_status', arguments: {} })).readOnly, false);
  assert.ok(payload(await client.callTool({ name: 'wiki_lint', arguments: {} })).findings);

  await invoke(client, 'wiki_write_page', { path: 'entities/mcp-new.md', content: '---\ntype: entity\ntitle: MCP new\n---\nNew evidence.' });
  await invoke(client, 'wiki_update_page', { path: 'entities/mcp-new.md', patch: { append: '\nUpdated.' } });
  await invoke(client, 'wiki_create_entity', { name: 'MCP entity', content: 'Entity evidence.' });
  await invoke(client, 'wiki_create_concept', { name: 'MCP concept', content: 'Concept evidence.' });
  await invoke(client, 'wiki_write_page', { path: 'entities/link-source.md', content: '---\ntype: entity\n---\n[Sample](sample-01.md)' });
  const crosslinks = await invoke(client, 'wiki_add_crosslinks', { path: 'entities/link-source.md' });
  assert.equal(crosslinks.linked, 1, JSON.stringify(crosslinks));
  assert.ok((await invoke(client, 'wiki_update_index', {})).indexed > 0);

  const secret = 'TOP_SECRET_TOKEN';
  const refused = await client.callTool({ name: 'wiki_write_page', arguments: { path: 'entities/secret.md', content: `token: ${secret}` } });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /E_SECRET_DETECTED/);
  assert.equal(refused.content[0].text.includes(secret), false);
  const traversal = await client.callTool({ name: 'wiki_write_page', arguments: { path: '../outside.md', content: 'ordinary text' } });
  assert.equal(traversal.isError, true);
  assert.match(traversal.content[0].text, /E_PATH_ESCAPE/);
  const outside = resolve(env.home, 'outside.md');
  await writeFile(outside, 'untouched');
  await symlink(outside, resolve(env.vault, 'wiki/entities/escape.md'));
  const symlinkEscape = await client.callTool({ name: 'wiki_write_page', arguments: { path: 'entities/escape.md', content: 'ordinary text' } });
  assert.equal(symlinkEscape.isError, true);
  assert.match(symlinkEscape.content[0].text, /E_PATH_ESCAPE/);
  assert.equal(await readFile(outside, 'utf8'), 'untouched');
  const logged = await readFile(resolve(env.vault, 'wiki/log.md'), 'utf8');
  assert.match(logged, /update-index/);
  assert.equal(logged.includes(secret), false);
});

test('readOnly stdio server omits every write tool', async (t) => {
  const env = await setup(true); t.after(async () => rm(env.home, { recursive: true, force: true }));
  const { client, transport } = await connect(env); t.after(async () => { await client.close(); await transport.close(); });
  const names = (await client.listTools()).tools.map((item) => item.name);
  assert.deepEqual(names.sort(), ['wiki_lint', 'wiki_list_pages', 'wiki_query', 'wiki_read_index', 'wiki_read_page', 'wiki_status'].sort());
  assert.equal(names.some((name) => writeTools.includes(name)), false);
});
