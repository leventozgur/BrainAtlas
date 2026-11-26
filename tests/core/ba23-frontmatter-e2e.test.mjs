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
import { runHook } from '../../packages/hooks/src/index.mjs';

const NOW = new Date('2026-11-11T00:00:00Z');
const GOOD = '---\ntitle: "Good"\nstatus: confirmed\nverified: []\n---\n\n# Good\n\nzephyr good note text.\n';
const BROKEN = '---\ntitle: [unclosed\n---\n\n# Broken\n\nzephyr broken note text.\n';
const FIXED =
  '---\ntitle: "Broken"\nstatus: confirmed\nverified: []\n---\n\n# Broken\n\nzephyr broken note text, fixed.\n';

function fixture(t, files) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ba23-e2e-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const vault = path.join(home, 'vault'),
    wiki = path.join(vault, 'wiki'),
    state = path.join(home, 'state'),
    userHome = path.join(home, 'home');
  fs.mkdirSync(wiki, { recursive: true });
  fs.mkdirSync(state);
  fs.mkdirSync(userHome);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true });
    fs.writeFileSync(path.join(vault, rel), text);
  }
  const config = defaultConfig('lite');
  config.vault.path = vault;
  config.stateDir = state;
  config.retrieval = { ...config.retrieval, abstainThreshold: 0 };
  return { home, vault, wiki, state, userHome, config };
}

async function connect(f) {
  const server = createServer({
    config: f.config,
    paths: { vaultDir: f.vault, stateDir: f.state },
    env: { HOME: f.userHome },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'ba23-test', version: '1' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

async function mcpQuery(client, text) {
  const result = await client.callTool({ name: 'wiki_query', arguments: { query: text } });
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text).results.map((item) => item.path);
}

async function hookContext(f, prompt, session) {
  const config = { ...f.config, retrieval: { abstainThreshold: 0 } };
  const r = await runHook({
    client: 'claude',
    event: 'prompt',
    stdin: JSON.stringify({ session_id: session, prompt }),
    env: { HOME: f.userHome },
    config,
    now: NOW,
  });
  assert.equal(r.exitCode, 0);
  return r.stdout === '{}' ? '' : JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
}

test('prompt hook answers from the healthy pages when one page has broken frontmatter', async (t) => {
  const f = fixture(t, { 'wiki/good.md': GOOD, 'wiki/broken.md': BROKEN });
  const context = await hookContext(f, 'zephyr', 'ba23-hook-skip');
  assert.match(context, /Good \(wiki\/good\.md\)/);
  assert.doesNotMatch(context, /broken\.md/);
});

test('MCP wiki_query starts and answers from the healthy pages when one page has broken frontmatter', async (t) => {
  const f = fixture(t, { 'wiki/good.md': GOOD, 'wiki/broken.md': BROKEN });
  const mcp = await connect(f);
  t.after(() => mcp.close());
  assert.deepEqual(await mcpQuery(mcp.client, 'zephyr'), ['good.md']);
});

test('a page fixed after it was skipped is found by the next MCP wiki_query and the next hook call', async (t) => {
  const f = fixture(t, { 'wiki/good.md': GOOD, 'wiki/broken.md': BROKEN });
  const mcp = await connect(f);
  t.after(() => mcp.close());
  assert.deepEqual(await mcpQuery(mcp.client, 'zephyr'), ['good.md']);

  fs.writeFileSync(path.join(f.wiki, 'broken.md'), FIXED);
  assert.equal((await mcpQuery(mcp.client, 'zephyr broken'))[0], 'broken.md');

  assert.match(await hookContext(f, 'zephyr broken', 'ba23-hook-fixed'), /Broken \(wiki\/broken\.md\)/);
});
