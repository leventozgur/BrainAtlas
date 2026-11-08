// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, symlink, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../packages/mcp/src/index.mjs';
import { defaultConfig, SEMANTIC_DEFAULTS } from '../../packages/core/src/config/index.mjs';
import { createOllamaProvider, updateSemanticIndex, markdownChunks } from '../../modules/semantic/src/index.mjs';

test('MCP opt-in semantic search keeps lexical fallback and thresholds', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-semantic-')); t.after(() => rm(root, { recursive: true, force: true }));
  const wiki = join(root, 'vault/wiki'), stateDir = join(root, 'state'), releasesDir = join(root, 'releases'), release = join(releasesDir, 'v1');
  await mkdir(wiki, { recursive: true }); await mkdir(join(release, 'modules'), { recursive: true });
  await cp(resolve('modules/semantic'), join(release, 'modules/semantic'), { recursive: true }); await symlink(resolve('packages'), join(release, 'packages'));
  await writeFile(join(wiki, 'car.md'), '# Engine\ncar motor');
  const currentDir = join(root, 'current'); await symlink(release, currentDir);
  let calls = 0;
  const fetchImpl = async (_url, options) => { calls++; return { ok: true, json: async () => ({ embeddings: JSON.parse(options.body).input.map(text => /irrelevant|motor/u.test(text) && text.startsWith('task:') ? [0, 1] : [1, 0]) }) }; };
  const config = defaultConfig('custom'); config.modules = ['semantic']; config.vault.path = join(root, 'vault'); config.semantic = { ...SEMANTIC_DEFAULTS, enabled: true, dims: 2 };
  const provider = createOllamaProvider({ ...config.semantic, fetchImpl });
  await updateSemanticIndex({ corpusDir: wiki, stateDir, provider, chunkMarkdown: markdownChunks });
  const server = createServer({ config, paths: { stateDir, releasesDir, currentDir }, env: { HOME: root }, fetchImpl });
  const [ct, st] = InMemoryTransport.createLinkedPair(); const client = new Client({ name: 'test', version: '1' });
  await Promise.all([server.connect(st), client.connect(ct)]); t.after(async () => { await client.close(); await server.close(); });
  const query = async text => JSON.parse((await client.callTool({ name: 'wiki_query', arguments: { query: text } })).content[0].text);
  const cross = await query('araba'); assert.equal(cross.results[0].path, 'car.md'); assert.equal(cross.semantic.used, true); assert.equal(cross.results[0].heading, 'Engine');
  const absent = await query('irrelevant'); assert.equal(absent.abstained, true);
  const lexical = await query('motor'); assert.equal(lexical.abstained, false); assert.equal(lexical.results[0].path, 'car.md'); assert.ok(calls >= 4);
});
