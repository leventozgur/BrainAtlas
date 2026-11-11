// SPDX-License-Identifier: MIT
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
const pagePath = 'entities/sample-01.md';
const original = '---\ntype: entity\ntitle: Sample One\n---\nOriginal body.\n';

async function fixture(t) {
  const home = await mkdtemp(resolve(tmpdir(), 'ba14-patch-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const vault = resolve(home, 'vault');
  await mkdir(resolve(vault, 'wiki/entities'), { recursive: true });
  await writeFile(resolve(vault, 'wiki/log.md'), '# Wiki log\n');
  await writeFile(resolve(vault, 'wiki/entities/sample-01.md'), original);
  const config = defaultConfig('lite');
  config.vault.path = vault;
  const configFile = resolve(home, 'config.json');
  await writeFile(configFile, JSON.stringify(config));
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve(root, 'packages/mcp/bin/brainatlas-mcp.mjs')], cwd: root,
    env: { HOME: home, BRAINATLAS_CONFIG: configFile, BRAINATLAS_VAULT: vault, PATH: process.env.PATH ?? '' }, stderr: 'pipe' });
  const client = new Client({ name: 'ba14-patch-test', version: '1.0.0' });
  await client.connect(transport);
  t.after(async () => { await client.close(); });
  return { vault, client, pageFile: resolve(vault, 'wiki', pagePath), logFile: resolve(vault, 'wiki/log.md') };
}

async function update(client, patch) {
  return client.callTool({ name: 'wiki_update_page', arguments: { path: pagePath, patch } });
}
const text = (result) => (result.content ?? []).map((item) => item.text ?? '').join('\n');

test('wiki_update_page rejects an unknown patch key without writing or logging', async (t) => {
  const f = await fixture(t);
  const logBefore = await readFile(f.logFile, 'utf8');
  const result = await update(f.client, { title: 'Yeni baslik' });
  assert.equal(result.isError, true);
  assert.match(text(result), /E_INVALID_INPUT/);
  assert.equal(text(result).includes('Yeni baslik'), false);
  assert.equal(await readFile(f.pageFile, 'utf8'), original);
  assert.equal(await readFile(f.logFile, 'utf8'), logBefore);
});

test('wiki_update_page rejects a non-object frontmatter patch without writing', async (t) => {
  const f = await fixture(t);
  const result = await update(f.client, { frontmatter: 'status: active' });
  assert.equal(result.isError, true);
  assert.match(text(result), /E_INVALID_INPUT/);
  assert.equal(await readFile(f.pageFile, 'utf8'), original);
});

test('wiki_update_page rejects a mixed patch when any key is unknown', async (t) => {
  const f = await fixture(t);
  const result = await update(f.client, { append: '\nValid part.', extra: 'Unknown part.' });
  assert.equal(result.isError, true);
  assert.match(text(result), /E_INVALID_INPUT/);
  assert.equal(await readFile(f.pageFile, 'utf8'), original);
});

test('wiki_update_page still applies valid frontmatter, body and append patches', async (t) => {
  const f = await fixture(t);
  assert.equal((await update(f.client, { frontmatter: { status: 'active' } })).isError, undefined);
  let content = await readFile(f.pageFile, 'utf8');
  assert.match(content, /status: active/);
  assert.match(content, /type: entity/);
  assert.match(content, /title: Sample One/);
  assert.match(content, /Original body\./);

  assert.equal((await update(f.client, { body: 'Replaced body.' })).isError, undefined);
  content = await readFile(f.pageFile, 'utf8');
  assert.match(content, /Replaced body\./);
  assert.doesNotMatch(content, /Original body\./);

  assert.equal((await update(f.client, { append: '\nAppended line.' })).isError, undefined);
  assert.match(await readFile(f.pageFile, 'utf8'), /Replaced body\.\s*\nAppended line\./);
});
