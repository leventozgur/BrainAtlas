// SPDX-License-Identifier: MIT
// BA-29: wiki_query ranks the same scope as the hook; the navigation and policy files at the wiki root are not ranked, but
// they stay readable through wiki_read_page and wiki_list_pages. Hermetic: temporary directories only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { defaultConfig } from '../../packages/core/src/config/index.mjs';
import { createServer } from '../../packages/mcp/src/index.mjs';
import { SEMANTIC_DEFAULTS } from '../../packages/core/src/config/index.mjs';
import { createOllamaProvider, updateSemanticIndex, markdownChunks } from '../../modules/semantic/src/index.mjs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtemp, mkdir, cp, symlink, writeFile, rm } from 'node:fs/promises';

function fixture(t, exclude) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ba29-mcp-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const vault = path.join(home, 'vault'),
    wiki = path.join(vault, 'wiki'),
    stateDir = path.join(home, 'state');
  fs.mkdirSync(path.join(wiki, 'notes'), { recursive: true });
  fs.writeFileSync(path.join(wiki, 'index.md'), '# Catalog\nquokka catalog entry');
  fs.writeFileSync(path.join(wiki, 'log.md'), '# Log\nquokka log entry');
  fs.writeFileSync(path.join(wiki, 'AGENTS.md'), '# Policy\nquokka policy');
  fs.writeFileSync(path.join(wiki, 'notes', 'habitat.md'), '# Habitat\nquokka habitat is the rocky island');
  const config = defaultConfig('lite');
  config.vault.path = vault;
  config.retrieval = { ...config.retrieval, abstainThreshold: 0, ...(exclude === undefined ? {} : { exclude }) };
  return { home, vault, wiki, stateDir, config };
}
async function connect(f) {
  const server = createServer({
    config: f.config,
    paths: { vaultDir: f.vault, stateDir: f.stateDir },
    env: { HOME: f.home },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'ba29-test', version: '1' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    server,
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}
async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, name);
  return JSON.parse(result.content[0].text);
}

test('wiki_query does not rank the wiki root index, log or AGENTS.md, and ranks nested pages', async (t) => {
  const f = fixture(t);
  const mcp = await connect(f);
  t.after(() => mcp.close());
  const results = (await call(mcp.client, 'wiki_query', { query: 'quokka' })).results.map((r) => r.path);
  assert.deepEqual(results, ['notes/habitat.md']);
});

test('the excluded wiki root pages stay readable through the read tools', async (t) => {
  const f = fixture(t);
  const mcp = await connect(f);
  t.after(() => mcp.close());
  const index = await call(mcp.client, 'wiki_read_page', { path: 'index.md' });
  assert.match(JSON.stringify(index), /Catalog/);
  const page = await call(mcp.client, 'wiki_read_page', { path: 'AGENTS.md' });
  assert.match(JSON.stringify(page), /Policy/);
  // wiki_list_pages already omits wiki/index.md and wiki/log.md (unchanged); the policy file is still listed.
  const listed = await call(mcp.client, 'wiki_list_pages');
  assert.deepEqual(listed.pages.sort(), ['wiki/AGENTS.md', 'wiki/notes/habitat.md']);
});

test('retrieval.exclude [] ranks the wiki root pages again (legacy behaviour)', async (t) => {
  const f = fixture(t, []);
  const mcp = await connect(f);
  t.after(() => mcp.close());
  const results = (await call(mcp.client, 'wiki_query', { query: 'quokka' })).results.map((r) => r.path).sort();
  assert.deepEqual(results, ['AGENTS.md', 'index.md', 'log.md', 'notes/habitat.md']);
});

// BA-29: the MCP search root is wiki/ as before. Without wiki/ the server fails exactly like main (E_VAULT_MISSING).
test('a vault without wiki/ fails in MCP exactly as in the main checkout', (t) => {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  let main = null;
  try {
    const root = path.resolve(
      repo,
      execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: repo, encoding: 'utf8' }).trim(),
      '..'
    );
    if (fs.existsSync(path.join(root, 'packages/mcp/src/index.mjs'))) main = root;
  } catch {
    main = null;
  }
  if (!main) {
    t.skip('main checkout not found');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ba29-mcp-nowiki-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const vault = path.join(dir, 'vault');
  fs.mkdirSync(vault, { recursive: true });
  fs.writeFileSync(path.join(vault, 'notes.md'), '# Note\nquokka');
  const config = defaultConfig('lite');
  config.vault.path = vault;
  const attempt = (mod) => {
    try {
      mod.createServer({ config, paths: { vaultDir: vault, stateDir: path.join(dir, 'state') }, env: { HOME: dir } });
      return 'ok';
    } catch (error) {
      return error.code ?? 'other';
    }
  };
  const mainServer = import(pathToFileURL(path.join(main, 'packages/mcp/src/index.mjs')).href);
  return mainServer.then((mod) => {
    assert.equal(attempt({ createServer }), attempt(mod));
    assert.equal(attempt(mod), 'E_VAULT_MISSING');
  });
});

// BA-29: wiki_query with semantic enabled never returns an excluded page (fake embedding provider, as in the semantic tests).
test('semantic wiki_query leaves out an excluded wiki root page; the same query without the rule returns it', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ba29-mcp-sem-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const wiki = path.join(root, 'vault/wiki'),
    stateDir = path.join(root, 'state'),
    releasesDir = path.join(root, 'releases'),
    release = path.join(releasesDir, 'v1'),
    currentDir = path.join(root, 'current');
  await mkdir(wiki, { recursive: true });
  await mkdir(path.join(release, 'modules'), { recursive: true });
  await cp(path.resolve('modules/semantic'), path.join(release, 'modules/semantic'), { recursive: true });
  await symlink(path.resolve('packages'), path.join(release, 'packages'));
  await symlink(release, currentDir);
  await writeFile(path.join(wiki, 'index.md'), '# Catalogue\ncatalogue of pages');
  await writeFile(path.join(wiki, 'car.md'), '# Engine\ncar motor');
  // Queries and the catalogue page point the same way; the car page is a weaker but clear match.
  const vector = (text) => (text.startsWith('task:') || /catalogue/.test(text) ? [1, 0] : [0.8, 0.6]);
  const fetchImpl = async (_url, options) => ({
    ok: true,
    json: async () => ({ embeddings: JSON.parse(options.body).input.map(vector) }),
  });
  const semantic = { ...SEMANTIC_DEFAULTS, enabled: true, dims: 2 };
  const config0 = defaultConfig('custom');
  config0.modules = ['semantic'];
  config0.vault.path = path.join(root, 'vault');
  config0.semantic = semantic;
  await updateSemanticIndex({
    corpusDir: wiki,
    stateDir,
    provider: createOllamaProvider({ ...semantic, fetchImpl }),
    chunkMarkdown: markdownChunks,
  });
  const ask = async (exclude) => {
    const config = structuredClone(config0);
    if (exclude !== undefined) config.retrieval = { ...config.retrieval, exclude };
    const server = createServer({
      config,
      paths: { stateDir, releasesDir, currentDir },
      env: { HOME: root },
      fetchImpl,
    });
    const [ct, st] = InMemoryTransport.createLinkedPair(),
      client = new Client({ name: 'ba29-sem', version: '1' });
    await Promise.all([server.connect(st), client.connect(ct)]);
    t.after(async () => {
      await client.close();
      await server.close();
    });
    const result = JSON.parse(
      (await client.callTool({ name: 'wiki_query', arguments: { query: 'araba' } })).content[0].text
    );
    return { paths: result.results.map((r) => r.path), semantic: result.semantic };
  };
  const scoped = await ask(undefined);
  assert.equal(scoped.semantic.used, true, 'the semantic step ran');
  assert.deepEqual(scoped.paths, ['car.md']);
  const legacy = await ask([]);
  assert.equal(legacy.paths[0], 'index.md', 'without the rule the catalogue page is the first result');
});
