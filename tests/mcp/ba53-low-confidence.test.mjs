// SPDX-License-Identifier: MIT
// BA-53: opt-in low-confidence rows for pull queries (the wiki_query MCP tool and the wiki CLI). Hermetic: temporary
// vault, HOME and state directories only; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { defaultConfig } from '../../packages/core/src/config/index.mjs';
import { createSearcher } from '../../packages/core/src/retrieval/index.mjs';
import { callToolInProcess, createServer, serverOptions } from '../../packages/mcp/src/index.mjs';
import { cleanEnv } from '../cli/clean-env.mjs';

const BIN = resolve('packages/cli/bin/brainatlas.mjs');
const BASE_DESCRIPTION = 'Search verified Wiki evidence and return ranked snippets; compact omits the snippets.';
const EXTRA_SENTENCE =
  'Results marked lowConfidence scored below the abstain threshold; treat them as weak evidence and verify before relying on them.';
// Each query is measured against the fixture before use: WEAK is below_threshold, STRONG ranks well, NO_MATCH abstains
// with no_match and IDENTIFIER abstains with identifier-not-found.
const WEAK = 'deployment kubernetes ingress tls certificate renewal';
const STRONG = 'deployment pipeline release checks';
const NO_MATCH = 'kubernetes ingress controller tls';
const IDENTIFIER = 'E_MISSING_WIDGET_TIMEOUT';

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'ba53-low-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = join(base, 'home');
  const vault = join(base, 'vault');
  const stateDir = join(base, 'state');
  await mkdir(home, { recursive: true });
  await mkdir(join(vault, 'wiki', 'notes'), { recursive: true });
  await writeFile(join(vault, 'wiki', 'index.md'), '# Catalog\n');
  await writeFile(
    join(vault, 'wiki', 'notes', 'deployment.md'),
    '# Deployment\n\nThe deployment pipeline runs the release checks before shipping.\n'
  );
  await writeFile(
    join(vault, 'wiki', 'notes', 'garden.md'),
    '# Garden\n\nThe garden has tomatoes, basil and rosemary in raised beds.\n'
  );
  return { base, home, vault, stateDir };
}

function configFor(f, lowConfidence) {
  const config = defaultConfig('lite');
  config.vault.path = f.vault;
  if (lowConfidence !== undefined) config.retrieval = { ...config.retrieval, pullLowConfidence: lowConfidence };
  return config;
}

/** The core's own answer, used to prove the fixture query measures as the test expects. */
function measured(f, query) {
  const searcher = createSearcher({ vaultDir: join(f.vault, 'wiki'), stateDir: f.stateDir });
  return {
    abstained: searcher.search(query, { limit: 5, budgetChars: 4000, abstainThreshold: 0.35 }),
    all: searcher.search(query, { limit: 5, budgetChars: 4000, abstainThreshold: 0 }),
  };
}

async function withServer(f, config, work) {
  const server = createServer({ config, paths: { vaultDir: f.vault, stateDir: f.stateDir }, env: { HOME: f.home } });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'ba53-low-confidence', version: '1' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return await work(client);
  } finally {
    await client.close();
    await server.close();
  }
}

async function ask(f, config, args) {
  return withServer(f, config, async (client) => {
    const result = await client.callTool({ name: 'wiki_query', arguments: args });
    assert.notEqual(result.isError, true, result.content?.[0]?.text);
    return JSON.parse(result.content[0].text);
  });
}

async function queryDescription(f, config) {
  return withServer(f, config, async (client) => {
    const { tools } = await client.listTools();
    return tools.find((tool) => tool.name === 'wiki_query').description;
  });
}

test('key absent: a below-threshold query keeps the unchanged abstained response', async (t) => {
  const f = await fixture(t);
  const weak = measured(f, WEAK);
  assert.equal(weak.abstained.reason, 'below_threshold');
  assert.ok(weak.all.results.length > 0);
  const absent = await ask(f, configFor(f), { query: WEAK });
  const off = await ask(f, configFor(f, false), { query: WEAK });
  assert.deepEqual(absent, { results: [], abstained: true });
  assert.equal(JSON.stringify(absent), JSON.stringify(off));
});

test('key true + below_threshold: the rows are flagged and abstained stays true', async (t) => {
  const f = await fixture(t);
  const weak = measured(f, WEAK);
  const response = await ask(f, configFor(f, true), { query: WEAK });
  assert.deepEqual(Object.keys(response), ['results', 'abstained', 'lowConfidence']);
  assert.equal(response.abstained, true);
  assert.equal(response.lowConfidence, true);
  assert.deepEqual(
    response.results.map((row) => row.path),
    weak.all.results.map((row) => row.path)
  );
  for (const row of response.results) {
    assert.equal(row.lowConfidence, true);
    assert.equal(Object.keys(row).at(-1), 'lowConfidence');
    assert.ok(row.score < 0.35, 'a low-confidence row stays below the abstain threshold');
  }
});

test('key true + strong match: no lowConfidence key appears', async (t) => {
  const f = await fixture(t);
  assert.equal(measured(f, STRONG).abstained.reason, null);
  const response = await ask(f, configFor(f, true), { query: STRONG });
  assert.equal(response.abstained, false);
  assert.ok(response.results.length > 0);
  assert.equal(JSON.stringify(response).includes('lowConfidence'), false);
});

test('key true + no_match or identifier-not-found: no rows are returned', async (t) => {
  const f = await fixture(t);
  assert.equal(measured(f, NO_MATCH).abstained.reason, 'no_match');
  assert.equal(measured(f, IDENTIFIER).abstained.reason, 'identifier-not-found');
  const config = configFor(f, true);
  for (const query of [NO_MATCH, IDENTIFIER]) {
    assert.deepEqual(await ask(f, config, { query }), { results: [], abstained: true });
  }
});

test('key true + compact: only the snippet drops and lowConfidence stays last', async (t) => {
  const f = await fixture(t);
  const config = configFor(f, true);
  const full = await ask(f, config, { query: WEAK });
  const compact = await ask(f, config, { query: WEAK, compact: true });
  assert.ok(full.results.length > 0);
  assert.deepEqual(
    compact.results,
    full.results.map(({ snippet, ...rest }) => rest)
  );
  for (const row of compact.results) {
    assert.equal('snippet' in row, false);
    assert.equal(Object.keys(row).at(-1), 'lowConfidence');
  }
  assert.equal(compact.abstained, true);
  assert.equal(compact.lowConfidence, true);
});

test('the extra description sentence appears only when the key is true', async (t) => {
  const f = await fixture(t);
  assert.equal(await queryDescription(f, configFor(f)), BASE_DESCRIPTION);
  assert.equal(await queryDescription(f, configFor(f, false)), BASE_DESCRIPTION);
  assert.equal(await queryDescription(f, configFor(f, true)), `${BASE_DESCRIPTION} ${EXTRA_SENTENCE}`);
});

test('the wiki CLI returns the same low-confidence object as the MCP tool', async (t) => {
  const f = await fixture(t);
  const configFile = join(f.home, 'config.json');
  await writeFile(configFile, JSON.stringify(configFor(f, true)));
  const env = cleanEnv({
    HOME: f.home,
    XDG_CONFIG_HOME: join(f.home, 'config'),
    XDG_DATA_HOME: join(f.home, 'data'),
    XDG_STATE_HOME: join(f.home, 'state'),
    BRAINATLAS_PLATFORM: 'linux',
    BRAINATLAS_OFFLINE: '1',
    BRAINATLAS_CONFIG: configFile,
    BRAINATLAS_VAULT: f.vault,
    PATH: process.env.PATH || '/usr/bin:/bin',
  });
  const options = await serverOptions(env);
  const inProcess = JSON.parse((await callToolInProcess(options, 'wiki_query', { query: WEAK })).text);
  const run = spawnSync(process.execPath, [BIN, 'wiki', 'query', WEAK, '--json'], {
    env,
    encoding: 'utf8',
    shell: false,
    timeout: 30000,
  });
  assert.equal(run.error, undefined, 'command timed out');
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), inProcess);
  assert.equal(inProcess.abstained, true);
  assert.equal(inProcess.lowConfidence, true);
});
