// SPDX-License-Identifier: MIT
// BA-02 independent final verification (not written by the implementer).
// (c) a successful MCP write whose post-write refresh fails still returns success; the next wiki_query finds the new content.
// Also: unchanged vault reads no page contents; a same-size rewrite with the mtime restored is still detected.
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
import { createSearcher } from '../../../packages/core/src/retrieval/index.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const BIN = path.join(root, 'packages/mcp/bin/brainatlas-mcp.mjs');
const ASOF = new Date('2026-02-01T00:00:00Z');
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ba02-ind-mcp-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const vault = path.join(home, 'vault'), wiki = path.join(vault, 'wiki');
  fs.mkdirSync(wiki, { recursive: true });
  fs.writeFileSync(path.join(wiki, 'base.md'), '# Base\nbaseline evidence\n');
  fs.writeFileSync(path.join(wiki, 'blocker.md'), '# Blocker\nblocker text\n');
  const config = defaultConfig('lite');
  config.vault.path = vault;
  config.retrieval = { ...config.retrieval, abstainThreshold: 0 };
  const configFile = path.join(home, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify(config));
  return { home, vault, wiki, configFile, blocker: path.join(wiki, 'blocker.md') };
}
async function start(f) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [BIN], cwd: root,
    env: { HOME: f.home, BRAINATLAS_CONFIG: f.configFile, BRAINATLAS_VAULT: f.vault, PATH: process.env.PATH ?? '' }, stderr: 'pipe' });
  const client = new Client({ name: 'ba02-ind', version: '1.0.0' });
  await client.connect(transport);
  return { client, close: async () => { await client.close().catch(() => {}); await transport.close().catch(() => {}); } };
}
async function query(c, text) {
  const result = await c.client.callTool({ name: 'wiki_query', arguments: { query: text } });
  assert.notEqual(result.isError, true, `wiki_query failed: ${result.content?.[0]?.text}`);
  return JSON.parse(result.content[0].text).results.map((item) => item.path);
}
// Make a page unreadable (owner-only permission change): lstat still works, readFile fails with EACCES.
function makeUnreadable(file) { fs.chmodSync(file, 0o000); }
function makeReadable(file) { fs.chmodSync(file, 0o644); }

test('(c) MCP write succeeds when the post-write refresh fails; the next wiki_query finds the new page', async (t) => {
  if (isRoot) { t.skip('permission-based failure needs a non-root user'); return; }
  const f = fixture(t);
  const c = await start(f); t.after(() => c.close());
  assert.deepEqual(await query(c, 'baseline'), ['base.md']);
  makeUnreadable(f.blocker); t.after(() => { try { makeReadable(f.blocker); } catch { /* removed with the fixture */ } });
  // The refresh inside the write must fail (a page cannot be read), while the write itself must succeed.
  const written = await c.client.callTool({ name: 'wiki_write_page', arguments: { path: 'wiki/fresh.md', content: '---\ntitle: Fresh\n---\n# Fresh\nquokkanew evidence\n' } });
  assert.notEqual(written.isError, true, `write must succeed: ${written.content?.[0]?.text}`);
  assert.equal(fs.readFileSync(path.join(f.wiki, 'fresh.md'), 'utf8').includes('quokkanew'), true, 'the page is on disk');
  // While the failure persists, queries keep working and do not error; they serve the last good index.
  const during = await c.client.callTool({ name: 'wiki_query', arguments: { query: 'quokkanew' } });
  assert.notEqual(during.isError, true, 'query during the failed refresh must not be an error');
  assert.deepEqual(JSON.parse(during.content[0].text).results.map((r) => r.path), [], 'stale index is served while the refresh fails');
  assert.deepEqual(await query(c, 'baseline'), ['base.md']);
  // Once the page is readable again, the next query picks up the change without any other action.
  makeReadable(f.blocker);
  assert.deepEqual(await query(c, 'quokkanew'), ['fresh.md']);
});

test('(c) in-process: a failed refresh keeps the last good index; the next refreshIfChanged recovers', async (t) => {
  if (isRoot) { t.skip('permission-based failure needs a non-root user'); return; }
  const f = fixture(t);
  const s = createSearcher({ vaultDir: f.wiki, stateDir: path.join(f.home, 'state'), now: ASOF });
  const opts = { limit: 5, abstainThreshold: 0, asOf: ASOF };
  makeUnreadable(f.blocker); t.after(() => { try { makeReadable(f.blocker); } catch { /* removed with the fixture */ } });
  fs.writeFileSync(path.join(f.wiki, 'fresh.md'), '# Fresh\nquokkanew evidence\n');
  await assert.rejects(s.refresh());
  assert.deepEqual(s.search('quokkanew', opts).results, [], 'last good index still answers');
  assert.equal(s.search('baseline', opts).results[0].path, 'base.md');
  assert.throws(() => s.refreshIfChanged());
  assert.deepEqual(s.search('quokkanew', opts).results, [], 'failed refreshIfChanged keeps the last good index');
  makeReadable(f.blocker);
  assert.equal(s.refreshIfChanged(), true);
  assert.equal(s.search('quokkanew', opts).results[0].path, 'fresh.md');
});

test('(c) unchanged vault: refreshIfChanged reads no .md contents (spy on readFileSync and openSync)', (t) => {
  const f = fixture(t);
  const s = createSearcher({ vaultDir: f.wiki, stateDir: path.join(f.home, 'state'), now: ASOF });
  const reads = [];
  const { readFileSync, openSync } = fs;
  fs.readFileSync = (file, ...rest) => { reads.push(String(file)); return readFileSync(file, ...rest); };
  fs.openSync = (file, ...rest) => { reads.push(String(file)); return openSync(file, ...rest); };
  t.after(() => { fs.readFileSync = readFileSync; fs.openSync = openSync; });
  for (let i = 0; i < 3; i++) assert.equal(s.refreshIfChanged(), false);
  fs.readFileSync = readFileSync; fs.openSync = openSync;
  assert.deepEqual(reads.filter((p) => p.endsWith('.md')), []);
});

test('(c) same-size rewrite with mtime restored: detected; ctime is the observed change', (t) => {
  const f = fixture(t);
  const s = createSearcher({ vaultDir: f.wiki, stateDir: path.join(f.home, 'state'), now: ASOF });
  const opts = { limit: 5, abstainThreshold: 0, asOf: ASOF };
  const file = path.join(f.wiki, 'base.md');
  const before = fs.lstatSync(file, { bigint: true });
  fs.writeFileSync(file, '# Base\nwombats evidence!\n'); // 'baseline evidence' and 'wombats evidence!' are both 17 characters
  execFileSync('python3', ['-c', 'import os,sys; os.utime(sys.argv[1], ns=(int(sys.argv[2]), int(sys.argv[3])))', file, before.atimeNs.toString(), before.mtimeNs.toString()]);
  const after = fs.lstatSync(file, { bigint: true });
  console.log(`same-size probe: size ${before.size}->${after.size}, mtime restored=${after.mtimeNs === before.mtimeNs}, ctime changed=${after.ctimeNs !== before.ctimeNs}`);
  assert.equal(after.size, before.size, 'same size');
  assert.equal(after.mtimeNs, before.mtimeNs, 'mtime restored to the nanosecond');
  assert.equal(s.refreshIfChanged(), true, 'the change is detected through ctime even with size and mtime unchanged');
  assert.equal(s.search('wombats', opts).results[0]?.path, 'base.md', 'the rewrite is visible after the change check');
});
