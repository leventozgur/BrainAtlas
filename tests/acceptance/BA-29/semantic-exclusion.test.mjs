// SPDX-License-Identifier: MIT
// BA-29 independent acceptance, item 6: with the semantic module on (fake embedding provider, in-process fetch), the MCP hybrid
// result never names an excluded root page (wiki/index.md, wiki/log.md). The hook's semantic step runs in a worker that uses
// the global fetch, so it cannot be given a fake provider in-process; its filter is checked by reading the code, not here.
// Hermetic: temporary directories, an injected fetch that answers in memory, no sockets, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, symlink, writeFile, rm } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { defaultConfig, SEMANTIC_DEFAULTS } from '../../../packages/core/src/config/index.mjs';
import { createServer } from '../../../packages/mcp/src/index.mjs';
import { createOllamaProvider, updateSemanticIndex, markdownChunks } from '../../../modules/semantic/src/index.mjs';

const CAND = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
// Every text gets the same vector, so semantic similarity alone puts every page in the answer for any query.
const fakeFetch = async (_url, options) => ({ ok: true, json: async () => ({ embeddings: JSON.parse(options.body).input.map(() => [1, 0]) }) });

async function fixture(t, pages) {
  const root = await mkdtemp(join(tmpdir(), 'ba29-semantic-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const wiki = join(root, 'vault/wiki'), stateDir = join(root, 'state'), releasesDir = join(root, 'releases'), release = join(releasesDir, 'v1'), currentDir = join(root, 'current');
  await mkdir(wiki, { recursive: true }); await mkdir(join(release, 'modules'), { recursive: true }); await mkdir(stateDir, { recursive: true });
  await cp(join(CAND, 'modules/semantic'), join(release, 'modules/semantic'), { recursive: true });
  await symlink(join(CAND, 'packages'), join(release, 'packages')); await symlink(release, currentDir);
  for (const [rel, body] of Object.entries(pages)) { await mkdir(dirname(join(wiki, rel)), { recursive: true }); await writeFile(join(wiki, rel), body); }
  const config = defaultConfig('custom');
  config.modules = ['semantic']; config.vault.path = join(root, 'vault');
  config.semantic = { ...SEMANTIC_DEFAULTS, enabled: true, dims: 2 };
  const provider = createOllamaProvider({ ...config.semantic, fetchImpl: fakeFetch });
  await updateSemanticIndex({ corpusDir: wiki, stateDir, provider, chunkMarkdown: markdownChunks });
  const server = createServer({ config, paths: { stateDir, releasesDir, currentDir }, env: { HOME: root }, fetchImpl: fakeFetch });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'ba29-semantic', version: '1' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  t.after(async () => { await client.close(); await server.close(); });
  return async (query) => JSON.parse((await client.callTool({ name: 'wiki_query', arguments: { query } })).content[0].text);
}

const PAGES = {
  'index.md': '---\ntitle: Index\nstatus: active\n---\n# Index\n\ncar engine navigation page for the wiki.\n',
  'log.md': '# Log\n\ncar engine log line.\n',
  'car.md': '# Engine\n\ncar motor and engine notes.\n',
  'sub/other.md': '# Other\n\nunrelated gardening text.\n',
};

test('item 6: MCP hybrid with the semantic module on never returns wiki/index.md or wiki/log.md', async (t) => {
  const query = await fixture(t, PAGES);
  const hybrid = await query('araba');
  assert.equal(hybrid.semantic?.used, true, `semantic must be used: ${JSON.stringify(hybrid.semantic)}`);
  const paths = hybrid.results.map((item) => item.path);
  assert.ok(paths.includes('car.md'), `car.md expected in ${JSON.stringify(paths)}`);
  assert.ok(!paths.includes('index.md'), `index.md must be excluded: ${JSON.stringify(paths)}`);
  assert.ok(!paths.includes('log.md'), `log.md must be excluded: ${JSON.stringify(paths)}`);
  assert.ok(paths.every((p) => p === 'car.md' || p === 'sub/other.md'), JSON.stringify(paths));
});

test('item 6: a query whose only semantic and lexical match is an excluded root page returns no excluded path', async (t) => {
  const query = await fixture(t, PAGES);
  const r = await query('navigation');
  const paths = r.results.map((item) => item.path);
  assert.ok(!paths.includes('index.md'), `index.md must not be returned: ${JSON.stringify(paths)}`);
  assert.ok(!paths.includes('log.md'), `log.md must not be returned: ${JSON.stringify(paths)}`);
});
