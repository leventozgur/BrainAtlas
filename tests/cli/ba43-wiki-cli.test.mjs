// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { defaultConfig } from '../../packages/core/src/config/index.mjs';
import { formatWikiResult } from '../../packages/cli/src/wiki.mjs';
import { cleanEnv } from './clean-env.mjs';

const BIN = resolve('packages/cli/bin/brainatlas.mjs');
const ROOT = resolve('.');

const page = (title, body) =>
  `---\ntype: concept\ntitle: ${JSON.stringify(title)}\ngenerated: "2026-11-01"\nstatus: confirmed\nsources: []\nverified: []\nstale_after: "P90D"\naliases: []\nkeywords: []\n---\n\n# ${title}\n\n${body}\n`;

async function write(dir, rel, text) {
  const file = join(dir, rel);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text);
}

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'ba43-wiki-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = join(base, 'home');
  const vault = join(base, 'vault');
  await mkdir(home, { recursive: true });
  await write(
    vault,
    'wiki/index.md',
    '# Wiki Index\n\n## Concepts\n\n- [Alpha term](concepts/alpha.md)\n- [Beta term](concepts/beta.md)\n'
  );
  await write(vault, 'wiki/log.md', '# Log\n');
  await write(
    vault,
    'wiki/concepts/alpha.md',
    page('Alpha', 'alpha keyword body.\n\n## Details\n\nmore alpha keyword text.\n\n## Notes\n\nnotes text.\n')
  );
  await write(vault, 'wiki/concepts/beta.md', page('Beta', 'beta keyword body.\n\n## Details\n\nmore beta text.\n'));
  await write(vault, 'wiki/entities/gamma.md', page('Gamma', 'gamma entity body.\n'));
  await write(vault, 'wiki/summaries/delta.md', page('Delta', 'delta summary body.\n'));
  const env = cleanEnv({
    HOME: home,
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_DATA_HOME: join(home, 'data'),
    XDG_STATE_HOME: join(home, 'state'),
    BRAINATLAS_PLATFORM: 'linux',
    BRAINATLAS_OFFLINE: '1',
    BRAINATLAS_VAULT: vault,
    PATH: process.env.PATH || '/usr/bin:/bin',
  });
  const run = (...args) =>
    spawnSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8', shell: false, timeout: 15000 });
  return { base, home, vault, env, run };
}

async function snapshot(root) {
  const out = {};
  async function visit(dir, rel) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        out[childRel] = 'dir';
        await visit(join(dir, entry.name), childRel);
        continue;
      }
      out[childRel] = await readFile(join(dir, entry.name), 'utf8');
    }
  }
  await visit(root, '');
  return out;
}

async function mcpClient(t, env) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BIN, 'mcp'],
    cwd: ROOT,
    env,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'ba43-parity', version: '1.0.0' });
  await client.connect(transport);
  t.after(async () => {
    await client.close();
  });
  return client;
}

async function mcpValue(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError === true, false, result.content[0].text);
  return JSON.parse(result.content[0].text);
}

function cliJson(run, ...args) {
  const result = run('wiki', ...args, '--json');
  assert.equal(result.error, undefined, 'command timed out');
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

const PARITY = [
  ['query', 'alpha'],
  ['query', 'alpha', '--limit', '1'],
  ['query', 'alpha', '--compact'],
  ['read', 'concepts/alpha.md'],
  ['read', 'wiki/concepts/alpha.md'],
  ['read', 'concepts/alpha.md#details'],
  ['read', 'concepts/alpha.md', '--anchor', 'details'],
  ['read', 'concepts/alpha.md', '--max-chars', '10'],
  ['read', 'index.md'],
  ['list'],
  ['list', '--type', 'concepts'],
  ['status'],
  ['lint'],
];
const TOOL_CASES = [
  ['wiki_query', { query: 'alpha' }],
  ['wiki_query', { query: 'alpha', limit: 1 }],
  ['wiki_query', { query: 'alpha', compact: true }],
  ['wiki_read_page', { path: 'concepts/alpha.md' }],
  ['wiki_read_page', { path: 'wiki/concepts/alpha.md' }],
  ['wiki_read_page', { path: 'concepts/alpha.md#details' }],
  ['wiki_read_page', { path: 'concepts/alpha.md', anchor: 'details' }],
  ['wiki_read_page', { path: 'concepts/alpha.md', maxChars: 10 }],
  ['wiki_read_page', { path: 'index.md' }],
  ['wiki_list_pages', {}],
  ['wiki_list_pages', { type: 'concepts' }],
  ['wiki_status', {}],
  ['wiki_lint', {}],
];

test('every subcommand --json deep-equals the registered MCP read tool', async (t) => {
  const f = await fixture(t);
  const client = await mcpClient(t, f.env);
  assert.equal(PARITY.length, TOOL_CASES.length);
  for (let index = 0; index < PARITY.length; index++) {
    const [name, args] = TOOL_CASES[index];
    const fromCli = cliJson(f.run, ...PARITY[index]);
    const fromMcp = await mcpValue(client, name, args);
    if (name === 'wiki_status') {
      fromCli.indexAgeMs = 0;
      fromMcp.indexAgeMs = 0;
    }
    assert.deepEqual(fromCli, fromMcp, `${name} ${JSON.stringify(args)}`);
  }
  const abstained = cliJson(f.run, 'query', 'nothing-matches-this');
  assert.deepEqual(abstained, await mcpValue(client, 'wiki_query', { query: 'nothing-matches-this' }));
  assert.equal(abstained.abstained, true);
});

test('tool errors keep the tool code and message; argument errors are E_ARGUMENT', async (t) => {
  const f = await fixture(t);
  const client = await mcpClient(t, f.env);
  const escape = f.run('wiki', 'read', '../x.md', '--json');
  assert.equal(escape.status, 1);
  assert.equal(JSON.parse(escape.stdout).error.code, 'E_PATH_ESCAPE');
  const mcpMissing = await client.callTool({ name: 'wiki_read_page', arguments: { path: 'missing.md' } });
  assert.equal(mcpMissing.isError, true);
  const missing = f.run('wiki', 'read', 'missing.md', '--json');
  assert.equal(missing.status, 1);
  assert.equal(
    JSON.parse(missing.stdout).error.code,
    /^(E_[A-Z0-9_]+)/u.exec(mcpMissing.content[0].text)?.[1] ?? 'E_WIKI_TOOL'
  );
  const anchor = f.run('wiki', 'read', 'concepts/alpha.md', '--anchor', 'nope', '--json');
  assert.equal(anchor.status, 1);
  assert.equal(JSON.parse(anchor.stdout).error.code, 'E_INVALID_INPUT');
  const limit = f.run('wiki', 'query', 'alpha', '--limit', '50');
  assert.notEqual(limit.status, 0);
  assert.doesNotMatch(limit.stderr, /\n\s+at /u);

  for (const args of [
    [],
    ['foo'],
    ['query'],
    ['read'],
    ['index', 'extra'],
    ['query', 'x', '--limit', 'abc'],
    ['list', '--bogus'],
  ]) {
    const result = f.run('wiki', ...args, '--json');
    assert.equal(result.status, 1, args.join(' '));
    assert.equal(JSON.parse(result.stdout).error.code, 'E_ARGUMENT', args.join(' '));
  }
});

test('text output follows the query, read, index and list formats', async (t) => {
  const f = await fixture(t);
  const query = f.run('wiki', 'query', 'alpha');
  assert.equal(query.status, 0, query.stderr);
  assert.match(query.stdout, /^1\. concepts\/alpha\.md/mu);
  assert.match(query.stdout, /\n {3}/u);
  assert.equal(f.run('wiki', 'query', 'nothing-matches-this').stdout.trim(), 'No confident match.');

  const read = f.run('wiki', 'read', 'concepts/alpha.md', '--max-chars', '10');
  assert.equal(read.status, 0, read.stderr);
  assert.ok(read.stdout.startsWith('---\ntype:'));
  assert.ok(read.stdout.includes('[truncated]'));

  const list = f.run('wiki', 'list');
  assert.equal(list.status, 0, list.stderr);
  assert.deepEqual(list.stdout.trim().split('\n'), [
    'wiki/concepts/alpha.md',
    'wiki/concepts/beta.md',
    'wiki/entities/gamma.md',
    'wiki/summaries/delta.md',
  ]);
  assert.equal(formatWikiResult('list', { pages: [] }), '');
});

test('--vault overrides the environment vault and the configured vault is the default', async (t) => {
  const f = await fixture(t);
  const other = join(f.base, 'other');
  await write(other, 'wiki/index.md', '# Other\n');
  await write(other, 'wiki/concepts/only.md', page('Only', 'other body.\n'));
  const overridden = cliJson(f.run, 'list', '--vault', other);
  assert.deepEqual(overridden.pages, ['wiki/concepts/only.md']);

  const env = cleanEnv({
    HOME: f.home,
    XDG_CONFIG_HOME: join(f.home, 'config'),
    XDG_STATE_HOME: join(f.home, 'state'),
    BRAINATLAS_PLATFORM: 'linux',
    BRAINATLAS_OFFLINE: '1',
    PATH: process.env.PATH,
  });
  const config = defaultConfig('lite');
  config.vault.path = f.vault;
  const configFile = join(f.home, 'brainatlas.json');
  await writeFile(configFile, JSON.stringify(config));
  const result = spawnSync(process.execPath, [BIN, 'wiki', 'list', '--json'], {
    env: { ...env, BRAINATLAS_CONFIG: configFile },
    encoding: 'utf8',
    shell: false,
    timeout: 15000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).pages.length, 4);
});

test('every subcommand leaves the vault byte for byte unchanged', async (t) => {
  const f = await fixture(t);
  const before = await snapshot(f.vault);
  const commands = [
    ['query', 'alpha'],
    ['read', 'concepts/alpha.md'],
    ['read', 'index.md'],
    ['list'],
    ['status'],
    ['lint'],
    ['query', 'alpha', '--compact'],
    ['list', '--type', 'concepts'],
    ['read', 'concepts/alpha.md', '--anchor', 'details'],
  ];
  for (const args of commands) {
    const result = f.run('wiki', ...args, '--json');
    assert.equal(result.error, undefined, `${args[0]} timed out`);
    assert.equal(result.status, 0, `${args[0]}: ${result.stderr}`);
    assert.deepEqual(await snapshot(f.vault), before, args[0]);
  }
});

test('help lists wiki with its description and usage', async (t) => {
  const f = await fixture(t);
  const all = f.run('--help', '--json');
  assert.equal(all.status, 0, all.stderr);
  const command = JSON.parse(all.stdout).commands.find((item) => item.name === 'wiki');
  assert.equal(
    command.description,
    'Wiki tools from the shell, running the same code as the MCP tools: query, read, list, status, lint; write, update, create, link and reindex change the Wiki.'
  );
  assert.match(
    command.usage,
    /^brainatlas wiki query <text> \[--limit N\] \[--compact\] \[--provenance\] \| read <path>/u
  );
  const detail = f.run('help', 'wiki');
  assert.equal(detail.status, 0, detail.stderr);
  assert.match(detail.stdout, /--max-chars N/u);
});
