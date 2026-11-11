// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { defaultConfig } from '../../packages/core/src/config/index.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// Read tools must not follow symlinks either: a page or directory linked from outside the Wiki is invisible to them.
test('wiki_list_pages and wiki_status ignore symlinked pages and directories outside the Wiki', async (t) => {
  const home = await mkdtemp(resolve(tmpdir(), 'ba14-symlist-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const vault = resolve(home, 'vault');
  const wiki = resolve(vault, 'wiki');
  const outside = resolve(home, 'outside');
  await mkdir(resolve(wiki, 'entities'), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(resolve(wiki, 'entities/real.md'), '---\ntitle: Real\n---\nReal.\n');
  await writeFile(resolve(outside, 'file.md'), '---\ntitle: Outside\n---\nOutside.\n');
  await symlink(resolve(outside, 'file.md'), resolve(wiki, 'entities/link.md'));
  await symlink(outside, resolve(wiki, 'linkdir'));
  const config = defaultConfig('lite');
  config.vault.path = vault;
  const configFile = resolve(home, 'config.json');
  await writeFile(configFile, JSON.stringify(config));
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve(root, 'packages/mcp/bin/brainatlas-mcp.mjs')], cwd: root,
    env: { HOME: home, BRAINATLAS_CONFIG: configFile, BRAINATLAS_VAULT: vault, PATH: process.env.PATH ?? '' }, stderr: 'pipe' });
  const client = new Client({ name: 'ba14-symlist-test', version: '1.0.0' });
  await client.connect(transport);
  t.after(() => client.close());
  const list = JSON.parse((await client.callTool({ name: 'wiki_list_pages', arguments: {} })).content[0].text);
  assert.deepEqual(list.pages, ['wiki/entities/real.md']);
  const status = JSON.parse((await client.callTool({ name: 'wiki_status', arguments: {} })).content[0].text);
  assert.equal(status.pageCount, 1);
});
