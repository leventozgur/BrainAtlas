// SPDX-License-Identifier: MIT
// BA-20: one page whose frontmatter cannot be read (a raw C0 control character in an unquoted value) does not fail
// wiki_update_index for the whole Wiki; that page is still listed with the no-title fallback, and the other pages are
// indexed. Real stdio MCP server, temporary HOME and vault, no network.
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
const BAD = '---\ntype: entity\ntitle: A\u0001B\n---\nG.\n';
const GOOD = '---\ntype: entity\ntitle: Tamam\n---\nG.\n';

async function fixture(t, files) {
  const home = await mkdtemp(resolve(tmpdir(), 'ba20-unreadable-'));
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
  const client = new Client({ name: 'ba20-unreadable-test', version: '1.0.0' });
  await client.connect(transport);
  t.after(async () => { await client.close(); });
  return { wiki, client };
}

test('BA20-UNREADABLE1: an unreadable page is listed with the no-title fallback; the other pages are indexed; runs two and three change nothing', async (t) => {
  const f = await fixture(t, { 'entities/bad.md': BAD, 'entities/ok.md': GOOD });
  const first = await f.client.callTool({ name: 'wiki_update_index', arguments: {} });
  assert.notEqual(first.isError, true, first.content?.[0]?.text);
  assert.deepEqual(JSON.parse(first.content[0].text), { indexed: 2, added: 2, removed: 0 });
  const text = await readFile(resolve(f.wiki, 'index.md'), 'utf8');
  assert.ok(text.includes('- [Tamam](entities/ok.md)\n'), 'the readable page is indexed with its title');
  assert.equal(text.split('\n').filter((line) => line.includes('entities/bad.md')).length, 1, 'the unreadable page has one entry line');
  for (let run = 2; run <= 3; run++) {
    const again = await f.client.callTool({ name: 'wiki_update_index', arguments: {} });
    assert.notEqual(again.isError, true, again.content?.[0]?.text);
    assert.deepEqual(JSON.parse(again.content[0].text), { indexed: 2, added: 0, removed: 0 }, `run ${run}`);
    assert.equal(await readFile(resolve(f.wiki, 'index.md'), 'utf8'), text, `run ${run} keeps the bytes`);
  }
});
