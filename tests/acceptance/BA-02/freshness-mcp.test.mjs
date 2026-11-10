// SPDX-License-Identifier: MIT
// BA-02 blind acceptance: external edits must be visible to the next wiki_query of a real stdio MCP server.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { defaultConfig } from '../../../packages/core/src/config/index.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const BIN = path.join(root, 'packages/mcp/bin/brainatlas-mcp.mjs');

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ba02-mcp-fresh-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const vault = path.join(home, 'vault'), wiki = path.join(vault, 'wiki');
  fs.mkdirSync(wiki, { recursive: true });
  fs.writeFileSync(path.join(wiki, 'base.md'), '# Base\nbaseline evidence\n');
  const config = defaultConfig('lite');
  config.vault.path = vault;
  config.retrieval = { ...config.retrieval, abstainThreshold: 0 };
  const configFile = path.join(home, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify(config));
  return { home, vault, wiki, configFile };
}
async function start(f) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [BIN], cwd: root,
    env: { HOME: f.home, BRAINATLAS_CONFIG: f.configFile, BRAINATLAS_VAULT: f.vault, PATH: process.env.PATH ?? '' }, stderr: 'pipe' });
  const client = new Client({ name: 'ba02-fresh', version: '1.0.0' });
  await client.connect(transport);
  return { client, transport, close: async () => { await client.close().catch(() => {}); await transport.close().catch(() => {}); } };
}
async function queryRaw(c, text) {
  return c.client.callTool({ name: 'wiki_query', arguments: { query: text } });
}
async function query(c, text) {
  const result = await queryRaw(c, text);
  assert.notEqual(result.isError, true, `wiki_query failed: ${result.content?.[0]?.text}`);
  return JSON.parse(result.content[0].text).results.map((item) => item.path);
}
function utimesExact(file, ref) {
  // Restore the reference mtime to the nanosecond; Node's utimes truncates to milliseconds.
  execFileSync('python3', ['-c', 'import os,sys; os.utime(sys.argv[1], ns=(int(sys.argv[2]), int(sys.argv[3])))', file, ref.atimeNs.toString(), ref.mtimeNs.toString()]);
}

test('external add, edit, rename and delete are visible to the next wiki_query over stdio', async (t) => {
  const f = fixture(t);
  const c = await start(f); t.after(() => c.close());
  assert.deepEqual(await query(c, 'zephyr'), []);
  fs.writeFileSync(path.join(f.wiki, 'added.md'), '# Added\nzephyr appears\n');
  assert.deepEqual(await query(c, 'zephyr'), ['added.md']);
  fs.writeFileSync(path.join(f.wiki, 'added.md'), '# Added\nquokka replaces it\n');
  assert.deepEqual(await query(c, 'zephyr'), []);
  assert.deepEqual(await query(c, 'quokka'), ['added.md']);
  fs.renameSync(path.join(f.wiki, 'added.md'), path.join(f.wiki, 'moved.md'));
  assert.deepEqual(await query(c, 'quokka'), ['moved.md']);
  fs.rmSync(path.join(f.wiki, 'moved.md'));
  assert.deepEqual(await query(c, 'quokka'), []);
  assert.deepEqual(await query(c, 'baseline'), ['base.md']);
});

test('same-size external rewrite with the original mtime restored is visible over stdio', async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.wiki, 'swap.md'), '# Swap\nfoxtrot here\n');
  const c = await start(f); t.after(() => c.close());
  assert.deepEqual(await query(c, 'foxtrot'), ['swap.md']);
  const file = path.join(f.wiki, 'swap.md');
  const ref = fs.lstatSync(file, { bigint: true });
  fs.writeFileSync(file, '# Swap\nwombats here\n'); // 'foxtrot' and 'wombats' both 7 bytes
  utimesExact(file, ref);
  assert.equal(fs.lstatSync(file, { bigint: true }).mtimeNs, ref.mtimeNs);
  assert.deepEqual(await query(c, 'wombats'), ['swap.md']);
  assert.deepEqual(await query(c, 'foxtrot'), []);
});

test('a page written through a second MCP process on the same vault is visible without restart', async (t) => {
  const f = fixture(t);
  const reader = await start(f); t.after(() => reader.close());
  const writer = await start(f); t.after(() => writer.close());
  assert.deepEqual(await query(reader, 'vermilion'), []);
  const result = await writer.client.callTool({ name: 'wiki_write_page', arguments: { path: 'wiki/other-agent.md', content: '---\ntitle: Other agent\n---\n# Other agent\nvermilion note\n' } });
  assert.notEqual(result.isError, true);
  assert.deepEqual(await query(reader, 'vermilion'), ['other-agent.md']);
  // And the reverse direction: the reader's view must follow the writer's delete through its own (external) edit.
  fs.rmSync(path.join(f.wiki, 'other-agent.md'));
  assert.deepEqual(await query(writer, 'vermilion'), []);
  assert.deepEqual(await query(reader, 'vermilion'), []);
});

test('a symlinked page is never returned, even after it is created at runtime', async (t) => {
  const f = fixture(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ba02-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, 'secret.md'), '# Secret\nsecretmarker value\n');
  const c = await start(f); t.after(() => c.close());
  fs.symlinkSync(path.join(outside, 'secret.md'), path.join(f.wiki, 'link.md'));
  assert.deepEqual(await query(c, 'secretmarker'), []);
  const read = await c.client.callTool({ name: 'wiki_read_page', arguments: { path: 'wiki/link.md' } });
  assert.ok(read.isError === true || !String(read.content?.[0]?.text).includes('secretmarker'), 'symlink target content must not be readable as a page');
});

test('concurrent deletes and renames during queries do not crash the server', async (t) => {
  const f = fixture(t);
  for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(f.wiki, `churn-${i}.md`), `# Churn ${i}\nchurnterm ${i}\n`);
  const c = await start(f); t.after(() => c.close());
  let stop = false;
  const churn = (async () => {
    for (let round = 0; round < 40 && !stop; round++) {
      const i = round % 20;
      const file = path.join(f.wiki, `churn-${i}.md`);
      try { fs.renameSync(file, file + '.tmp'); } catch { /* already moved */ }
      try { fs.renameSync(file + '.tmp', file); } catch { /* already restored */ }
      try { fs.rmSync(file); } catch { /* absent */ }
      fs.writeFileSync(file, `# Churn ${i}\nchurnterm ${i}\n`);
      await new Promise((r) => setTimeout(r, 2));
    }
  })();
  const outcomes = { ok: 0, toolError: 0, transport: 0 };
  for (let q = 0; q < 60; q++) {
    try {
      const result = await queryRaw(c, 'churnterm');
      if (result.isError) {
        outcomes.toolError++;
        assert.match(result.content[0].text, /^E_[A-Z_]+: |^E_MCP_OPERATION/, 'errors must be the generic refusal text');
      } else outcomes.ok++;
    } catch { outcomes.transport++; }
  }
  stop = true;
  await churn;
  console.log(`churn outcomes: ${JSON.stringify(outcomes)}`);
  assert.equal(outcomes.transport, 0, 'server process must stay up');
  // After quiescence, the server must converge to the final vault state.
  const files = fs.readdirSync(f.wiki).filter((n) => /^churn-\d+\.md$/.test(n)).length;
  assert.equal(files, 20);
  const settled = await query(c, 'churnterm');
  assert.equal(settled.length, 5, `expected top-5 after churn, got ${settled.length}`);
});
