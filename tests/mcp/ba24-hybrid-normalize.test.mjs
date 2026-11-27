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
import {
  createOllamaProvider,
  updateSemanticIndex,
  markdownChunks,
  readSemanticIndex,
} from '../../modules/semantic/src/index.mjs';
import { searchHybrid } from '../../modules/semantic/src/hybrid.mjs';
import * as core from '../../packages/core/src/index.mjs';

async function start(t, { files, budgetChars = 4000, mode = 'semantic-primary', vectorOf = () => [1, 0], limit }) {
  const root = await mkdtemp(join(tmpdir(), 'ba24-hybrid-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const wiki = join(root, 'vault/wiki'),
    stateRoot = join(root, 'state'),
    stateDir = join(stateRoot, core.vaultId(join(root, 'vault'))),
    releasesDir = join(root, 'releases'),
    release = join(releasesDir, 'v1');
  await mkdir(wiki, { recursive: true });
  await mkdir(join(release, 'modules'), { recursive: true });
  await cp(resolve('modules/semantic'), join(release, 'modules/semantic'), { recursive: true });
  await symlink(resolve('packages'), join(release, 'packages'));
  const currentDir = join(root, 'current');
  await symlink(release, currentDir);
  for (const [name, text] of Object.entries(files)) await writeFile(join(wiki, name), text);
  const fetchImpl = async (_url, options) => ({
    ok: true,
    json: async () => ({
      embeddings: JSON.parse(options.body).input.map((text) => (text.startsWith('task:') ? [1, 0] : vectorOf(text))),
    }),
  });
  const config = defaultConfig('custom');
  config.modules = ['semantic'];
  config.vault.path = join(root, 'vault');
  config.retrieval = { ...config.retrieval, budgetChars };
  config.semantic = { ...SEMANTIC_DEFAULTS, enabled: true, dims: 2, mode };
  const provider = createOllamaProvider({ ...config.semantic, fetchImpl });
  await updateSemanticIndex({ corpusDir: wiki, stateDir, provider, chunkMarkdown: markdownChunks });
  const server = createServer({
    config,
    paths: { stateDir: stateRoot, releasesDir, currentDir },
    env: { HOME: root },
    fetchImpl,
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'ba24-test', version: '1' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  const query = async (text) =>
    JSON.parse(
      (await client.callTool({ name: 'wiki_query', arguments: { query: text, ...(limit ? { limit } : {}) } }))
        .content[0].text
    );
  return { query, wiki, stateDir, provider };
}

const durum = `---\ntitle: Durum\nstatus: confirmed\n---\n# Güncel durum\nalpha kaynak notu.\n## Notes\nfirst section words\n# Diger\n## Notes\nsecond section zeta words\n## 🚀 Plan 😀\nastral plan text\n`;

test('BA-24 B1: hybrid anchors equal the lexical anchors for diacritic, repeated and astral headings', async (t) => {
  const { query } = await start(t, { files: { 'durum.md': durum } });
  const dir = await mkdtemp(join(tmpdir(), 'ba24-lex-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const wiki = join(dir, 'wiki');
  await mkdir(wiki, { recursive: true });
  await writeFile(join(wiki, 'durum.md'), durum);
  const index = core.buildIndex(core.loadPages(wiki));
  for (const [text, expected] of [
    ['alpha kaynak', 'guncel-durum'],
    ['zeta', 'notes-1'],
    ['plan', '-plan-'],
  ]) {
    const hybrid = await query(text);
    assert.equal(hybrid.semantic?.used, true, `${text}: semantic must be used`);
    const row = hybrid.results.find((item) => item.path === 'durum.md');
    assert.ok(row, `${text}: durum.md must be returned`);
    const lexicalRow = core.search(index, text, { limit: 5 }).results.find((item) => item.path === 'durum.md');
    assert.ok(lexicalRow, `${text}: lexical answer must contain durum.md`);
    assert.equal(lexicalRow.anchor, expected, `${text}: lexical anchor reference`);
    assert.equal(row.anchor, lexicalRow.anchor, `${text}: hybrid anchor must equal lexical anchor`);
    assert.equal(row.headingPath, lexicalRow.headingPath, `${text}: hybrid headingPath must equal lexical headingPath`);
  }
});

test('BA-24 B1 core: the section bestSection picks for a page equals the core search section for a lexically matched query', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ba24-core-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const wiki = join(dir, 'wiki');
  await mkdir(wiki, { recursive: true });
  await writeFile(join(wiki, 'durum.md'), durum);
  const index = core.buildIndex(core.loadPages(wiki));
  const body = core.loadPages(wiki)[0].body;
  const asOf = new Date(index.now);
  for (const text of ['alpha kaynak', 'zeta', 'plan', 'first section']) {
    const lexicalRow = core.search(index, text, { limit: 5 }).results.find((item) => item.path === 'durum.md');
    assert.ok(lexicalRow, `${text}: lexical match expected`);
    const terms = [...new Set(core.tokens(text, true))];
    const found = core.bestSection(body, terms, index, asOf);
    assert.ok(found, `${text}: bestSection must find the section`);
    assert.deepEqual(
      { heading: found.heading, anchor: found.anchor, headingPath: found.headingPath },
      { heading: lexicalRow.heading, anchor: lexicalRow.anchor, headingPath: lexicalRow.headingPath },
      text
    );
  }
});

test('BA-24 B1 query section: a page outside the lexical answer takes the core section for the query on its own body', async (t) => {
  const { query } = await start(t, {
    files: { 'durum.md': durum, 'other.md': '# Other\nzeta zeta zeta zeta words\n' },
    limit: 1,
    vectorOf: (text) => (text.includes('zeta zeta') ? [0.1, 0.995] : [1, 0]),
  });
  const result = await query('zeta');
  assert.equal(result.results.length, 1);
  const row = result.results[0];
  assert.equal(row.path, 'durum.md');
  assert.equal(row.heading, 'Notes');
  assert.equal(row.anchor, 'notes-1');
  assert.equal(row.headingPath, 'Diger > Notes');
});

test('BA-24 B2: a snippet cut at the budget never ends with a lone high surrogate', async (t) => {
  const { query } = await start(t, { files: { 'snip.md': '# Snip\nabcdefgh😀ijk\n' }, budgetChars: 16 });
  const result = await query('ijk');
  const row = result.results.find((item) => item.path === 'snip.md');
  assert.ok(row, 'snip.md must be returned');
  assert.equal(row.snippet, '# Snip\nabcdefgh');
  assert.ok(!/[\uD800-\uDBFF]$/u.test(row.snippet), 'snippet must not end with a lone high surrogate');
});

test('BA-24 B3: score follows rrfScore in rrf mode and semanticScore is an extra field', async (t) => {
  const { query } = await start(t, {
    files: { 'a.md': '# Alpha\nalpha alpha notes\n', 'b.md': '# Zeta\nzeta words\n' },
    mode: 'rrf',
    vectorOf: (text) => (text.includes('zeta') ? [1, 0] : [0.1, 0.995]),
  });
  const result = await query('alpha');
  assert.equal(result.semantic.used, true);
  const scores = result.results.map((item) => item.score);
  assert.equal(scores.length, 2);
  for (let i = 1; i < scores.length; i++)
    assert.ok(scores[i - 1] >= scores[i], `scores must be non-increasing: ${scores}`);
  const a = result.results.find((item) => item.path === 'a.md');
  assert.ok(Math.abs(a.semanticScore - 0.1) < 1e-3, 'semanticScore must carry the cosine value');
  assert.equal(a.score, a.rrfScore, 'rrf mode: score is rrfScore');
  assert.notEqual(a.score, a.semanticScore, 'score must not be the cosine value');
});

test('BA-24 order: both modes keep the module order, and score is the active mode key', async (t) => {
  const files = {
    'a.md': '# Alpha\nalpha alpha notes\n',
    'b.md': '# Zeta\nzeta words\n',
    'c.md': '# Gamma\nalpha gamma words\n',
  };
  const vectorOf = (text) => (text.includes('zeta') ? [1, 0] : text.includes('gamma') ? [-0.5, 0.866] : [0.1, 0.995]);
  for (const mode of ['rrf', 'semantic-primary']) {
    const { query, wiki, stateDir, provider } = await start(t, { files, mode, vectorOf });
    const result = await query('alpha');
    const index = await readSemanticIndex(stateDir);
    const direct = await searchHybrid({
      query: 'alpha',
      pages: core.loadPages(wiki),
      lexicalIndex: core.buildIndex(core.loadPages(wiki)),
      entries: index.entries,
      provider,
      limit: 5,
      indexMeta: index,
      mode,
      minSemanticScore: SEMANTIC_DEFAULTS.minScore,
      abstainThreshold: 0.35,
    });
    assert.deepEqual(
      result.results.map((item) => item.path),
      direct.map((item) => item.path),
      `${mode}: order equals module order`
    );
    const expectedOrder = mode === 'rrf' ? ['a.md', 'b.md', 'c.md'] : ['b.md', 'a.md', 'c.md'];
    assert.deepEqual(
      result.results.map((item) => item.path),
      expectedOrder,
      `${mode}: order`
    );
    result.results.forEach((item, i) => {
      const expected = mode === 'rrf' ? direct[i].rrfScore : (direct[i].semanticScore ?? 0);
      assert.equal(item.score, expected, `${mode}: score of ${item.path}`);
      assert.equal(item.rrfScore, direct[i].rrfScore, `${mode}: rrfScore of ${item.path}`);
      if (direct[i].semanticScore !== undefined)
        assert.equal(item.semanticScore, direct[i].semanticScore, `${mode}: semanticScore`);
      else
        assert.equal(
          Object.hasOwn(item, 'semanticScore'),
          false,
          `${mode}: no semanticScore for lexical-only ${item.path}`
        );
    });
    const scores = result.results.map((item) => item.score);
    for (let i = 1; i < scores.length; i++)
      assert.ok(scores[i - 1] >= scores[i], `${mode}: scores must be non-increasing: ${scores}`);
  }
});

test('BA-24 edge: a semantic-only hit takes the core anchor of its own chunk section, and default-mode scores stay ordered', async (t) => {
  const { query } = await start(t, { files: { 'durum.md': durum } });
  const result = await query('qqqq');
  assert.equal(result.semantic.used, true);
  const row = result.results.find((item) => item.path === 'durum.md');
  assert.ok(row, 'semantic-only hit must be returned');
  assert.equal(row.heading, 'Güncel durum');
  assert.equal(row.anchor, 'guncel-durum');
  assert.equal(row.headingPath, 'Güncel durum');
  const scores = result.results.map((item) => item.score);
  for (let i = 1; i < scores.length; i++)
    assert.ok(scores[i - 1] >= scores[i], `default-mode scores must be non-increasing: ${scores}`);
});
