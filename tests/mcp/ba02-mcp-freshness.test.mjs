// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { defaultConfig } from '../../packages/core/src/config/index.mjs';
import { createServer } from '../../packages/mcp/src/index.mjs';

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ba02-mcp-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const vault = path.join(home, 'vault'), wiki = path.join(vault, 'wiki'), stateDir = path.join(home, 'state');
  fs.mkdirSync(wiki, { recursive: true });
  fs.writeFileSync(path.join(wiki, 'base.md'), '# Base\nbaseline evidence');
  const config = defaultConfig('lite');
  config.vault.path = vault;
  config.retrieval = { ...config.retrieval, abstainThreshold: 0 };
  return { home, vault, wiki, stateDir, config };
}
async function connect(f) {
  const server = createServer({ config: f.config, paths: { vaultDir: f.vault, stateDir: f.stateDir }, env: { HOME: f.home } });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'ba02-test', version: '1' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client, close: async () => { await client.close(); await server.close(); } };
}
async function query(client, text) {
  const result = await client.callTool({ name: 'wiki_query', arguments: { query: text } });
  assert.notEqual(result.isError, true);
  return JSON.parse(result.content[0].text).results.map((item) => item.path);
}

test('pages changed outside the running MCP server are visible to the next wiki_query', async (t) => {
  const f = fixture(t);
  const mcp = await connect(f);
  t.after(() => mcp.close());
  assert.deepEqual(await query(mcp.client, 'zephyr'), []);

  fs.writeFileSync(path.join(f.wiki, 'added.md'), '# Added\nzephyr appears');
  assert.deepEqual(await query(mcp.client, 'zephyr'), ['added.md']);

  fs.writeFileSync(path.join(f.wiki, 'added.md'), '# Added\nquokka replaces it');
  assert.deepEqual(await query(mcp.client, 'zephyr'), []);
  assert.deepEqual(await query(mcp.client, 'quokka'), ['added.md']);

  fs.renameSync(path.join(f.wiki, 'added.md'), path.join(f.wiki, 'moved.md'));
  assert.deepEqual(await query(mcp.client, 'quokka'), ['moved.md']);

  fs.rmSync(path.join(f.wiki, 'moved.md'));
  assert.deepEqual(await query(mcp.client, 'quokka'), []);
  assert.deepEqual(await query(mcp.client, 'baseline'), ['base.md']);
});

test('a page written through a second MCP server on the same vault is visible without restarting', async (t) => {
  const f = fixture(t);
  const reader = await connect(f);
  const writer = await connect(f);
  t.after(async () => { await writer.close(); await reader.close(); });
  assert.deepEqual(await query(reader.client, 'vermilion'), []);
  const result = await writer.client.callTool({ name: 'wiki_write_page', arguments: { path: 'wiki/other-agent.md', content: '---\ntitle: Other agent\n---\n# Other agent\nvermilion note' } });
  assert.notEqual(result.isError, true);
  assert.deepEqual(await query(reader.client, 'vermilion'), ['other-agent.md']);
});

test('a freshness check that fails mid-scan does not fail wiki_query; the next query recovers', async (t) => {
  const f = fixture(t);
  const mcp = await connect(f);
  t.after(() => mcp.close());
  assert.deepEqual(await query(mcp.client, 'baseline'), ['base.md']);
  fs.writeFileSync(path.join(f.wiki, 'late.md'), '# Late\nlate evidence');
  const realRead = fs.readFileSync;
  let failures = 0;
  fs.readFileSync = function (file, ...rest) {
    if (String(file).endsWith('late.md') && failures === 0) { failures++; const e = new Error('gone'); e.code = 'ENOENT'; throw e; }
    return realRead.call(this, file, ...rest);
  };
  t.after(() => { fs.readFileSync = realRead; });
  // The first query hits the injected failure during the rebuild: it must still answer from the last good index.
  assert.deepEqual(await query(mcp.client, 'baseline'), ['base.md']);
  fs.readFileSync = realRead;
  assert.equal(failures, 1);
  // The next query retries the rebuild and sees the new page.
  assert.deepEqual(await query(mcp.client, 'late'), ['late.md']);
});

test('fix2: a successful write is not reported as an error when the follow-up refresh fails', async (t) => {
  const f = fixture(t);
  const mcp = await connect(f);
  t.after(() => mcp.close());
  const realRead = fs.readFileSync;
  let armed = true;
  fs.readFileSync = function (file, ...rest) {
    if (armed && String(file).endsWith('written.md')) { armed = false; const e = new Error('gone'); e.code = 'ENOENT'; throw e; }
    return realRead.call(this, file, ...rest);
  };
  t.after(() => { fs.readFileSync = realRead; });
  const result = await mcp.client.callTool({ name: 'wiki_write_page', arguments: { path: 'wiki/written.md', content: '# Written\nwrittenmarker' } });
  fs.readFileSync = realRead;
  assert.notEqual(result.isError, true, 'the write succeeded, so the tool must not report an error');
  assert.deepEqual(await query(mcp.client, 'writtenmarker'), ['written.md']);
});
