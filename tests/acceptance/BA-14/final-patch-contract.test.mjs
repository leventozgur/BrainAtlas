// SPDX-License-Identifier: MIT
// BA-14 final verification: (1) wiki_update_page rejects `__proto__`, `constructor` and `prototype` patch keys and a
// `__proto__` frontmatter key with E_INVALID_INPUT, writing nothing; (2) docs/contracts/mcp-tools.md statements are
// checked against behavior: the vendored readIndex note, read-only tool omission, and the root category.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { defaultConfig } from '../../../packages/core/src/config/index.mjs';
import { ROOT, SERVER_ROOT, startServer, call, okJson, refused, textOf, snapshot, logCount } from './harness.mjs';

// The server code under test is the worktree build, or the main checkout when BA14_TARGET=main (SERVER_ROOT).
const { createServer } = await import(pathToFileURL(join(SERVER_ROOT, 'packages/mcp/src/index.mjs')).href);
const { readIndex } = await import(pathToFileURL(join(SERVER_ROOT, 'vendor/llmwiki-core/dist/index.js')).href);

const PAGE_PATH = 'entities/p.md';
const PAGE = '---\ntype: entity\ntitle: Patch Sayfası\nstatus: active\n---\nEski gövde\n';

const PROTO_CASES = [
  ['top-level __proto__ object', '{"__proto__":{"x":"MARK-F1"}}'],
  ['top-level __proto__ beside a valid body', '{"body":"MARK-F2","__proto__":{"x":"MARK-F2"}}'],
  ['top-level __proto__ beside a valid frontmatter', '{"frontmatter":{"status":"MARK-F3"},"__proto__":"MARK-F3"}'],
  ['frontmatter __proto__ object', '{"frontmatter":{"__proto__":{"x":"MARK-F4"}}}'],
  ['frontmatter __proto__ string beside a valid key', '{"frontmatter":{"status":"MARK-F5","__proto__":"MARK-F5"}}'],
  ['top-level constructor object', '{"constructor":{"x":"MARK-F6"}}'],
  ['top-level prototype object', '{"prototype":{"x":"MARK-F7"}}'],
  ['top-level prototype beside a valid append', '{"append":"\\nMARK-F8","prototype":{"x":"MARK-F8"}}']
];
for (const [label, raw] of PROTO_CASES) {
  test(`PROTO (${label}): refused with E_INVALID_INPUT; no echo; file and log unchanged; a valid patch still works afterwards`, async (t) => {
    const f = await startServer(t, { files: { [PAGE_PATH]: PAGE } });
    const before = await snapshot(f.vault);
    const logBefore = await logCount(f.wiki, 'update-page');
    const r = await call(f.client, 'wiki_update_page', { path: PAGE_PATH, patch: JSON.parse(raw) });
    refused(r, 'E_INVALID_INPUT');
    assert.equal(/MARK-F/.test(textOf(r)), false, 'refusal echoes a caller value');
    assert.deepEqual(await snapshot(f.vault), before, 'file or log changed');
    assert.equal(await logCount(f.wiki, 'update-page'), logBefore, 'log changed');
    assert.deepEqual(okJson(await call(f.client, 'wiki_update_page', { path: PAGE_PATH, patch: { body: 'Sonra' } })), { path: 'wiki/entities/p.md', updated: true });
    assert.match(await readFile(join(f.wiki, PAGE_PATH), 'utf8'), /Sonra/);
  });
}

// ---------------------------------------------------------------- contract statements

const contract = await readFile(join(ROOT, 'docs/contracts/mcp-tools.md'), 'utf8');

test('contract: the vendored readIndex note holds (it does not unescape destinations and misreads balanced parentheses)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ba14-vendor-'));
  try {
    const file = join(dir, 'index.md');
    await writeFile(file, '# Wiki Index\n\n## entities\n\n- [Escaped](entities/a\\(b\\).md)\n- [Balanced](entities/c(d).md)\n');
    const paths = (await readIndex(file)).map((entry) => entry.path);
    assert.equal(paths.includes('entities/a(b).md'), false, 'vendored readIndex unexpectedly unescapes destinations');
    assert.equal(paths.includes('entities/c(d).md'), false, 'vendored readIndex unexpectedly reads balanced parentheses');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  assert.match(contract, /does not unescape link destinations and misreads unescaped balanced parentheses/);
});

// PM update (BA-19, 2026-11-11): fixed — fresh index writes are escaped.
test('contract: a Wiki-root page uses the ## Pages category, and a parenthesis page is written escaped, as the documented example shows', async (t) => {
  assert.match(contract, /A page at the Wiki root uses the category `## Pages`/);
  assert.match(contract, /`entities\/a\\\(b\\\)\.md`/);
  const f = await startServer(t, { files: { 'root-note.md': '---\ntitle: Kök\n---\nK.\n', 'entities/a(b).md': '---\ntitle: B\n---\nB.\n' } });
  okJson(await call(f.client, 'wiki_update_index'));
  const out = await readFile(join(f.wiki, 'index.md'), 'utf8');
  assert.match(out, /^## Pages$/m);
  assert.ok(out.includes('(root-note.md)') && out.includes('(entities/a\\(b\\).md)'), 'documented root category and escaped example');
});

test('contract: "Write tools are omitted when config.readOnly is true" holds for the wiki_update_index tool list', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ba14-ro-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const vault = join(dir, 'vault');
  await mkdir(join(vault, 'wiki'), { recursive: true });
  const config = defaultConfig('lite');
  config.vault.path = vault;
  config.readOnly = true;
  const server = createServer({ config, paths: { vaultDir: vault, stateDir: join(dir, 'state') }, env: { HOME: join(dir, 'home'), BRAINATLAS_VAULT: vault } });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'ba14-readonly-check', version: '1.0.0' });
  await server.connect(serverT);
  await client.connect(clientT);
  t.after(async () => { await client.close(); await server.close(); });
  const names = (await client.listTools()).tools.map((tool) => tool.name);
  assert.ok(names.includes('wiki_query') && names.includes('wiki_read_index'), 'read tools stay advertised');
  for (const write of ['wiki_write_page', 'wiki_update_page', 'wiki_create_entity', 'wiki_create_concept', 'wiki_add_crosslinks', 'wiki_update_index']) {
    assert.equal(names.includes(write), false, `${write} must be omitted when readOnly`);
  }
});
