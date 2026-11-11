// SPDX-License-Identifier: MIT
// BA-17 end-to-end through the real stdio MCP server (packages/mcp/bin/brainatlas-mcp.mjs), the same way the existing
// MCP contract tests do it. The Wiki budget comes from config.retrieval.budgetChars, which the server reads at start,
// so each budget is a fresh server process. Hermetic: temporary HOME and vault, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { loadRetrieval, configUrl, mcpBin, LONE_SURROGATE, ROOT } from './support.mjs';

const { defaultConfig } = await import(configUrl);
const ELL = '…';

function writeVault(home) {
  const vault = path.join(home, 'vault');
  const wiki = path.join(vault, 'wiki');
  fs.mkdirSync(wiki, { recursive: true });
  const bodies = {
    'emoji.md': 'alpha ' + '🚀'.repeat(90),
    'astral.md': 'alpha ' + '𝓐𝓑𝓒𝓓'.repeat(50),
    'family.md': 'alpha ' + '👨‍👩‍👧‍👦'.repeat(30),
    'flags.md': 'alpha ' + '🇹🇷🇩🇪'.repeat(30),
    'turkish.md': 'alpha çalışma İstanbul ığüşöç 😀'.repeat(12),
    'ascii.md': 'alpha ' + 'plain words only, nothing special here. '.repeat(20),
    'deep.md': 'Reference: d1/d2/d3/d4/d5/d6/d7/d8/d9/d10/d11/handler-x-13.mjs is the deep file.',
  };
  for (const [name, body] of Object.entries(bodies)) fs.writeFileSync(path.join(wiki, name), `---\ntitle: ${name}\n---\n${body}\n`);
  fs.writeFileSync(path.join(wiki, 'index.md'), '# Wiki index\n');
  fs.writeFileSync(path.join(wiki, 'log.md'), '# Log\n');
  return vault;
}

async function withServer(budgetChars, fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ba17-mcp-'));
  const cleanups = [];
  try {
    const vault = writeVault(home);
    const config = defaultConfig('lite');
    config.vault.path = vault;
    config.retrieval = { ...config.retrieval, budgetChars };
    const configFile = path.join(home, 'config.json');
    fs.writeFileSync(configFile, JSON.stringify(config));
    const transport = new StdioClientTransport({
      command: process.execPath, args: [mcpBin], cwd: ROOT, stderr: 'pipe',
      env: { HOME: home, BRAINATLAS_CONFIG: configFile, BRAINATLAS_VAULT: vault, PATH: process.env.PATH ?? '' },
    });
    const client = new Client({ name: 'ba17-acceptance', version: '1.0.0' });
    cleanups.push(async () => { await client.close(); await transport.close(); });
    await client.connect(transport);
    const call = async (name, args) => {
      const result = await client.callTool({ name, arguments: args });
      const text = result.content.find(item => item.type === 'text')?.text ?? '';
      return { isError: result.isError === true, payload: (() => { try { return JSON.parse(text); } catch { return text; } })() };
    };
    return await fn(call);
  } finally {
    for (const c of cleanups.reverse()) await c().catch(() => {});
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('wiki_query snippets through stdio MCP: budgets 1..400 sampled, no lone surrogate, total within budget, ellipsis rule', async () => {
  const budgets = [1, 2, 3, 7, 13, 64, 199, 400];
  let truncated = 0;
  for (const b of budgets) {
    await withServer(b, async (call) => {
      const r = await call('wiki_query', { query: 'alpha', limit: 8 });
      assert.equal(r.isError, false, `budget ${b}: tool error`);
      assert.equal(r.payload.abstained, false, `budget ${b}`);
      const total = r.payload.results.reduce((sum, x) => sum + x.snippet.length, 0);
      assert.ok(total <= b, `budget ${b}: total ${total}`);
      for (const x of r.payload.results) {
        assert.equal(LONE_SURROGATE.test(x.snippet), false, `budget ${b}: lone surrogate in ${x.path}`);
        if (x.snippet.endsWith(ELL)) truncated++;
      }
    });
  }
  assert.ok(truncated > 0, 'truncated snippets were exercised');
});

test('wiki_query through stdio MCP at budget 400: astral and family-emoji pages come back whole or cut cleanly', async () => {
  await withServer(400, async (call) => {
    const r = await call('wiki_query', { query: 'alpha', limit: 8 });
    const paths = r.payload.results.map(x => x.path);
    for (const p of ['emoji.md', 'astral.md', 'family.md', 'flags.md', 'turkish.md']) assert.ok(paths.includes(p), `${p} must be returned`);
    for (const x of r.payload.results) assert.equal(LONE_SURROGATE.test(x.snippet), false, x.path);
  });
});

test('wiki_query through stdio MCP: a deep path suffix is found, not identifier-not-found', async () => {
  await withServer(400, async (call) => {
    for (const q of ['d10/d11/handler-x-13.mjs', 'd11/handler-x-13.mjs', 'handler-x-13.mjs']) {
      const r = await call('wiki_query', { query: q, limit: 5 });
      assert.equal(r.payload.abstained, false, `${q} must not abstain`);
      assert.ok(r.payload.results.some(x => x.path === 'deep.md'), `${q} must return deep.md`);
    }
    const gapped = await call('wiki_query', { query: 'd9/d11/handler-x-13.mjs', limit: 5 });
    assert.equal(gapped.payload.abstained, true, 'a non-consecutive path must abstain');
    assert.deepEqual(gapped.payload.results, []);
  });
});
