// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { defaultConfig, SEMANTIC_DEFAULTS } from '../../packages/core/src/config/index.mjs';
import { createServer } from '../../packages/mcp/src/index.mjs';
import { createOllamaProvider, markdownChunks, updateSemanticIndex } from '../../modules/semantic/src/index.mjs';

const OPEN = '<!-- brainatlas:current-state -->';
const CLOSE = '<!-- /brainatlas:current-state -->';
const FRONTMATTER =
  '---\ntitle: "Quorum board"\nstatus: confirmed\nverified:\n  - date: "2026-01-12"\n    evidence: "review"\n    scope: "quorum"\n    source: "wiki/sources/q.md"\n---\n';
const BODY = (block) => `# Quorum board\n\n## 2026-01-05 notes\n\nThe rotation schedule runs nightly.\n\n${block}`;
const BLOCK = `## Current state (proposed 2026-11-18)\n${OPEN}\n- The zephyrite quorum disk is replicated.\n${CLOSE}\n`;

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'ba57-mcp-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = join(base, 'home');
  const vault = join(base, 'vault');
  const stateDir = join(base, 'state');
  await mkdir(home, { recursive: true });
  await mkdir(join(vault, 'wiki', 'notes'), { recursive: true });
  await writeFile(join(vault, 'wiki', 'index.md'), '# Catalog\n');
  await writeFile(join(vault, 'wiki', 'notes', 'board.md'), FRONTMATTER + BODY(BLOCK));
  await writeFile(join(vault, 'wiki', 'notes', 'plain.md'), `${FRONTMATTER}${BODY('')}`);
  return { base, home, vault, stateDir };
}

function configFor(f) {
  const config = defaultConfig('lite');
  config.vault.path = f.vault;
  return config;
}

async function ask(f, args) {
  const config = configFor(f);
  const server = createServer({ config, paths: { vaultDir: f.vault, stateDir: f.stateDir }, env: { HOME: f.home } });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'ba57-synthesized', version: '1' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = await client.callTool({ name: 'wiki_query', arguments: args });
    assert.notEqual(result.isError, true, result.content?.[0]?.text);
    return JSON.parse(result.content[0].text);
  } finally {
    await client.close();
    await server.close();
  }
}

async function semanticFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ba57-mcp-semantic-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const wiki = join(root, 'vault', 'wiki'),
    stateDir = join(root, 'state'),
    releasesDir = join(root, 'releases'),
    release = join(releasesDir, 'v1'),
    currentDir = join(root, 'current');
  await mkdir(wiki, { recursive: true });
  await mkdir(join(release, 'modules'), { recursive: true });
  await cp(resolve('modules/semantic'), join(release, 'modules', 'semantic'), { recursive: true });
  await symlink(resolve('packages'), join(release, 'packages'));
  await symlink(release, currentDir);
  await writeFile(join(wiki, 'index.md'), '# Catalog\n');
  await writeFile(join(wiki, 'board.md'), FRONTMATTER + BODY(BLOCK));
  const fetchImpl = async (_url, options) => ({
    ok: true,
    json: async () => ({ embeddings: JSON.parse(options.body).input.map(() => [1, 0]) }),
  });
  const config = defaultConfig('custom');
  config.modules = ['semantic'];
  config.vault.path = join(root, 'vault');
  config.semantic = { ...SEMANTIC_DEFAULTS, enabled: true, dims: 2 };
  await updateSemanticIndex({
    corpusDir: wiki,
    stateDir,
    provider: createOllamaProvider({ ...config.semantic, fetchImpl }),
    chunkMarkdown: markdownChunks,
  });
  const server = createServer({ config, paths: { stateDir, releasesDir, currentDir }, env: { HOME: root }, fetchImpl });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'ba57-semantic', version: '1' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  return async (query) =>
    JSON.parse((await client.callTool({ name: 'wiki_query', arguments: { query } })).content[0].text);
}

test('BA-57: the MCP semantic path flags the synthesized section and drops verified trust', async (t) => {
  const query = await semanticFixture(t);
  const answer = await query('zephyrite quorum');
  assert.equal(answer.semantic?.used, true, JSON.stringify(answer.semantic));
  const row = answer.results.find((item) => item.path === 'board.md');
  assert.ok(row, JSON.stringify(answer));
  assert.equal(row.synthesized, true);
  assert.equal(row.heading, 'Current state (proposed 2026-11-18)');
  assert.equal(Object.hasOwn(row, 'trust'), false, 'a synthesized row is not verified evidence');
});

test('BA-57: wiki_query returns synthesized: true for the accepted block and no verified trust on that row', async (t) => {
  const f = await fixture(t);
  const answer = await ask(f, { query: 'zephyrite quorum' });
  const row = answer.results.find((item) => item.path === 'notes/board.md');
  assert.ok(row, JSON.stringify(answer));
  assert.equal(row.synthesized, true);
  assert.equal(Object.hasOwn(row, 'trust'), false, 'a synthesized section is not verified evidence');
  assert.equal(row.heading, 'Current state (proposed 2026-11-18)');
});

test('BA-57: compact keeps the flag and still drops only the snippet', async (t) => {
  const f = await fixture(t);
  const answer = await ask(f, { query: 'zephyrite quorum', compact: true });
  const row = answer.results.find((item) => item.path === 'notes/board.md');
  assert.ok(row, JSON.stringify(answer));
  assert.equal(row.synthesized, true);
  assert.equal(Object.hasOwn(row, 'snippet'), false);
});

test('BA-57: a page without the block keeps its verified trust and gains no flag', async (t) => {
  const f = await fixture(t);
  const answer = await ask(f, { query: 'rotation schedule' });
  const row = answer.results.find((item) => item.path === 'notes/plain.md');
  assert.ok(row, JSON.stringify(answer));
  assert.equal(row.trust, 'verified');
  assert.equal(Object.hasOwn(row, 'synthesized'), false);
});
