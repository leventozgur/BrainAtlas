// SPDX-License-Identifier: MIT
// BA-43d: `brainatlas wiki` write subcommands run the registered MCP write tools in process, so a `cli` channel agent
// can save findings exactly as an MCP agent can. Hermetic: temporary vault, HOME and state directories only; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { defaultConfig } from '../../packages/core/src/config/index.mjs';
import { parseWikiArguments } from '../../packages/cli/src/wiki.mjs';
import { cleanEnv } from './clean-env.mjs';

const BIN = resolve('packages/cli/bin/brainatlas.mjs');
const ROOT = resolve('.');

const page = (title, body) =>
  `---\ntype: concept\ntitle: ${JSON.stringify(title)}\ngenerated: "2026-11-01"\nstatus: confirmed\nsources: []\nverified: []\nstale_after: "P90D"\n---\n\n# ${title}\n\n${body}\n`;

async function put(dir, rel, text) {
  const file = join(dir, rel);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text);
}

async function seedVault(vault) {
  await put(vault, 'wiki/index.md', '# Wiki Index\n\n## Concepts\n\n- [Alpha](concepts/alpha.md)\n');
  await put(vault, 'wiki/log.md', '# Log\n');
  await put(vault, 'wiki/concepts/alpha.md', page('Alpha', 'alpha body, see [Beta](beta.md).\n'));
  await put(vault, 'wiki/concepts/beta.md', page('Beta', 'beta body.\n'));
}

async function fixture(t, { readOnly = false } = {}) {
  const base = await mkdtemp(join(tmpdir(), 'ba43d-wiki-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = join(base, 'home');
  const vault = join(base, 'vault');
  await mkdir(home, { recursive: true });
  await seedVault(vault);
  const config = defaultConfig('lite');
  config.vault.path = vault;
  if (readOnly) config.readOnly = true;
  const configFile = join(home, 'brainatlas.json');
  await writeFile(configFile, JSON.stringify(config));
  const env = cleanEnv({
    HOME: home,
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_DATA_HOME: join(home, 'data'),
    XDG_STATE_HOME: join(home, 'state'),
    BRAINATLAS_PLATFORM: 'linux',
    BRAINATLAS_OFFLINE: '1',
    BRAINATLAS_CONFIG: configFile,
    PATH: process.env.PATH || '/usr/bin:/bin',
  });
  // `input` is standard input; without it the child gets an empty, closed pipe.
  const run = (args, input) =>
    spawnSync(process.execPath, [BIN, 'wiki', ...args, '--json'], {
      env,
      cwd: base,
      encoding: 'utf8',
      shell: false,
      timeout: 20000,
      ...(input === undefined ? {} : { input }),
    });
  const ok = (args, input) => {
    const result = run(args, input);
    assert.equal(result.error, undefined, 'command timed out');
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const fails = (args, input) => {
    const result = run(args, input);
    assert.equal(result.error, undefined, 'command timed out');
    assert.notEqual(result.status, 0, result.stdout);
    // stderr is `E_CODE: message`.
    const match = /^(E_[A-Z0-9_]+): (.*)$/msu.exec(result.stderr.trim());
    assert.ok(match, result.stderr);
    return { code: match[1], message: match[2], stderr: result.stderr };
  };
  return { base, home, vault, env, run, ok, fails };
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
      if (entry.isDirectory()) await visit(join(dir, entry.name), childRel);
      else out[childRel] = await readFile(join(dir, entry.name), 'utf8');
    }
  }
  await visit(root, '');
  return out;
}

// Write times differ between the two runs; everything else must be byte for byte the same.
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/gu;
const normalize = (tree) =>
  Object.fromEntries(
    Object.entries(tree)
      .filter(([rel]) => !rel.startsWith('.brainatlas') && !rel.includes('.cache'))
      .map(([rel, text]) => [rel, text.replace(ISO, '<time>')])
  );

async function mcpClient(t, env) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BIN, 'mcp'],
    cwd: ROOT,
    env,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'ba43d-parity', version: '1.0.0' });
  await client.connect(transport);
  t.after(() => client.close());
  return client;
}

const sha = (text) => createHash('sha256').update(text).digest('hex');
const NEW_PAGE = page('Gamma', 'gamma body.\n');
const APPEND = '\n\n## Update (2026-11-25)\n\nappended finding.\n';
const PATCH = { frontmatter: { status: 'proposed' }, append: '\n\npatched text.\n' };

test('every write subcommand returns the MCP tool value and leaves the same vault bytes', async (t) => {
  const cli = await fixture(t);
  const mcp = await fixture(t);
  const client = await mcpClient(t, mcp.env);
  const alphaSha = sha(await readFile(join(cli.vault, 'wiki/concepts/alpha.md')));
  const steps = [
    [['write', 'concepts/gamma.md'], NEW_PAGE, 'wiki_write_page', { path: 'concepts/gamma.md', content: NEW_PAGE }],
    [
      ['update', 'concepts/alpha.md', '--append', '--expected-sha256', alphaSha],
      APPEND,
      'wiki_update_page',
      { path: 'concepts/alpha.md', patch: { append: APPEND }, expectedSha256: alphaSha },
    ],
    [
      ['update', 'concepts/beta.md', '--patch'],
      JSON.stringify(PATCH),
      'wiki_update_page',
      { path: 'concepts/beta.md', patch: PATCH },
    ],
    [
      ['update', 'concepts/gamma.md'],
      page('Gamma', 'gamma replaced.\n'),
      'wiki_update_page',
      { path: 'concepts/gamma.md', content: page('Gamma', 'gamma replaced.\n') },
    ],
    [
      ['create-concept', 'Delta', 'Term'],
      'delta body.\n',
      'wiki_create_concept',
      { name: 'Delta Term', content: 'delta body.\n' },
    ],
    [
      ['create-entity', 'Çağrı', 'Merkezi'],
      'entity body.\n',
      'wiki_create_entity',
      { name: 'Çağrı Merkezi', content: 'entity body.\n' },
    ],
    [['crosslinks', 'concepts/alpha.md'], undefined, 'wiki_add_crosslinks', { path: 'concepts/alpha.md' }],
    [['update-index'], undefined, 'wiki_update_index', {}],
  ];
  for (const [args, input, name, toolArgs] of steps) {
    const fromCli = cli.ok(args, input);
    const result = await client.callTool({ name, arguments: toolArgs });
    assert.equal(result.isError === true, false, result.content[0].text);
    const fromMcp = JSON.parse(result.content[0].text);
    assert.deepEqual(fromCli, fromMcp, args.join(' '));
  }
  assert.deepEqual(normalize(await snapshot(cli.vault)), normalize(await snapshot(mcp.vault)));
  const log = await readFile(join(cli.vault, 'wiki/log.md'), 'utf8');
  for (const action of ['write-page', 'update-page', 'create-concept', 'create-entity', 'add-crosslinks'])
    assert.match(log, new RegExp(action), action);
});

test('content comes from --file or standard input, never from a word on the command line', async (t) => {
  const f = await fixture(t);
  await put(f.base, 'note.md', NEW_PAGE);
  assert.deepEqual(f.ok(['write', 'concepts/from-file.md', '--file', 'note.md']), {
    path: 'wiki/concepts/from-file.md',
    written: true,
  });
  assert.match(await readFile(join(f.vault, 'wiki/concepts/from-file.md'), 'utf8'), /gamma body\./u);
  f.ok(['write', 'concepts/from-stdin.md'], NEW_PAGE);
  assert.match(await readFile(join(f.vault, 'wiki/concepts/from-stdin.md'), 'utf8'), /gamma body\./u);

  const before = await snapshot(f.vault);
  assert.equal(f.fails(['write', 'concepts/empty.md']).code, 'E_ARGUMENT');
  assert.equal(f.fails(['write', 'concepts/blank.md'], ' \n').code, 'E_ARGUMENT');
  assert.equal(f.fails(['write', 'concepts/x.md', 'body', 'words'], NEW_PAGE).code, 'E_ARGUMENT');
  assert.equal(f.fails(['write', 'concepts/x.md', '--file', 'missing.md']).code, 'E_ARGUMENT');
  assert.equal(f.fails(['update', 'concepts/alpha.md', '--patch'], '{not json').code, 'E_ARGUMENT');
  assert.equal(f.fails(['update', 'concepts/alpha.md', '--patch', '--append'], '{}').code, 'E_ARGUMENT');
  assert.equal(f.fails(['write', 'concepts/x.md', '--expected-sha256', 'abc'], NEW_PAGE).code, 'E_ARGUMENT');
  assert.equal(f.fails(['crosslinks']).code, 'E_ARGUMENT');
  assert.equal(f.fails(['update-index', 'extra']).code, 'E_ARGUMENT');
  assert.equal(f.fails(['create-concept'], 'x\n').code, 'E_ARGUMENT');
  assert.deepEqual(await snapshot(f.vault), before);
});

test('tool refusals keep their code, write nothing and echo no content', async (t) => {
  const f = await fixture(t);
  const before = await snapshot(f.vault);
  const stale = sha('something else');
  const conflict = f.fails(['update', 'concepts/alpha.md', '--append', '--expected-sha256', stale], APPEND);
  assert.equal(conflict.code, 'E_CONFLICT');
  const secret = 'AKIA' + 'ABCDEFGHIJKLMNOP';
  const refused = f.fails(['write', 'concepts/secret.md'], page('Secret', `key ${secret}\n`));
  assert.equal(refused.code, 'E_SECRET_DETECTED');
  assert.ok(!JSON.stringify(refused).includes(secret));
  assert.equal(f.fails(['write', '../outside.md'], NEW_PAGE).code, 'E_PATH_ESCAPE');
  assert.equal(f.fails(['create-concept', 'Alpha'], 'again\n').code, 'E_ALREADY_EXISTS');
  assert.equal(f.fails(['update', 'concepts/alpha.md', '--patch'], '{"unknown":1}').code, 'E_INVALID_INPUT');
  assert.deepEqual(await snapshot(f.vault), before);
});

test('the sha256 from wiki read guards a later update, and the update returns the next one', async (t) => {
  const f = await fixture(t);
  const read = f.ok(['read', 'concepts/alpha.md']);
  const updated = f.ok(['update', 'concepts/alpha.md', '--append', '--expected-sha256', read.sha256], APPEND);
  assert.equal(updated.sha256, sha(await readFile(join(f.vault, 'wiki/concepts/alpha.md'))));
  assert.equal(
    f.fails(['update', 'concepts/alpha.md', '--append', '--expected-sha256', read.sha256], APPEND).code,
    'E_CONFLICT'
  );
});

test('a read-only installation refuses every write subcommand before reading input', async (t) => {
  const f = await fixture(t, { readOnly: true });
  const before = await snapshot(f.vault);
  for (const args of [
    ['write', 'concepts/x.md'],
    ['update', 'concepts/alpha.md', '--append'],
    ['create-concept', 'X'],
    ['create-entity', 'X'],
    ['crosslinks', 'concepts/alpha.md'],
    ['update-index'],
  ]) {
    assert.equal(f.fails(args).code, 'E_READ_ONLY', args.join(' '));
  }
  assert.ok(f.ok(['query', 'alpha']).results.length > 0);
  assert.deepEqual(await snapshot(f.vault), before);
});

test('the parser names every subcommand and keeps read arguments unchanged', () => {
  assert.throws(() => parseWikiArguments(['nope']), {
    code: 'E_ARGUMENT',
    message:
      'wiki requires one of: query, read, index, list, status, lint, write, update, create-entity, create-concept, crosslinks, update-index.',
  });
  assert.deepEqual(parseWikiArguments(['read', 'concepts/a.md', '--max-chars', '5']), {
    sub: 'read',
    vault: undefined,
    args: { path: 'concepts/a.md', maxChars: 5 },
    input: null,
  });
  assert.deepEqual(parseWikiArguments(['update', 'concepts/a.md', '--append', '--file=x.md']), {
    sub: 'update',
    vault: undefined,
    args: { path: 'concepts/a.md' },
    input: { mode: 'append', file: 'x.md' },
  });
});
