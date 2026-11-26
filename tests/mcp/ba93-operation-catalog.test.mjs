// SPDX-License-Identifier: MIT
// BA-93: one operation catalog drives the MCP tool list, descriptions and the agent instruction texts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { OPERATIONS, cliCommands, toolNames } from '../../packages/core/src/index.mjs';
import { defaultConfig } from '../../packages/core/src/config/index.mjs';
import { initVault } from '../../packages/core/src/vault/index.mjs';
import { callToolInProcess, createServer } from '../../packages/mcp/src/index.mjs';

const EXPECTED_TOOLS = [
  'wiki_query',
  'wiki_read_page',
  'wiki_list_pages',
  'wiki_status',
  'wiki_lint',
  'wiki_write_page',
  'wiki_update_page',
  'wiki_create',
  'wiki_add_crosslinks',
  'wiki_update_index',
  'plan_read',
  'plan_update',
];

async function fixture(t, { readOnly = false } = {}) {
  const base = await mkdtemp(join(tmpdir(), 'ba93-catalog-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = join(base, 'home');
  const vault = join(base, 'vault');
  await mkdir(home, { recursive: true });
  await initVault(vault);
  const config = defaultConfig('lite');
  config.vault.path = vault;
  config.readOnly = readOnly;
  const options = {
    config,
    paths: { vaultDir: vault, stateDir: join(home, 'state') },
    env: { HOME: home, BRAINATLAS_PLATFORM: 'linux' },
  };
  return { base, home, vault, options };
}

async function listed(options) {
  const server = createServer(options);
  const client = new Client({ name: 'ba93-catalog', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return (await client.listTools()).tools;
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

async function ok(options, name, args = {}) {
  const result = await callToolInProcess(options, name, args);
  assert.equal(result.isError, false, result.text);
  return JSON.parse(result.text);
}

async function failed(options, name, args = {}) {
  const result = await callToolInProcess(options, name, args);
  assert.equal(result.isError, true, result.text);
  return result.text;
}

test('the catalog lists every operation once with tool, shell form, kind and summary', () => {
  assert.equal(Object.isFrozen(OPERATIONS), true);
  assert.equal(OPERATIONS.length, EXPECTED_TOOLS.length);
  assert.deepEqual(toolNames(), EXPECTED_TOOLS);
  assert.deepEqual(cliCommands(), [
    'wiki query <text>',
    'wiki read <path>',
    'wiki list',
    'wiki status',
    'wiki lint',
    'wiki write <path>',
    'wiki update <path>',
    'wiki create <entity|concept> <name>',
    'wiki link <path>',
    'wiki reindex',
    'plan list',
    'plan new|add|set',
  ]);
  for (const operation of OPERATIONS) {
    assert.deepEqual(Object.keys(operation).sort(), ['cli', 'kind', 'summary', 'tool']);
    assert.ok(['read', 'write'].includes(operation.kind));
    assert.equal(typeof operation.summary, 'string');
    assert.ok(operation.summary.length > 0);
  }
  assert.deepEqual(
    OPERATIONS.filter(({ kind }) => kind === 'write').map(({ tool }) => tool),
    ['wiki_write_page', 'wiki_update_page', 'wiki_create', 'wiki_add_crosslinks', 'wiki_update_index', 'plan_update']
  );
});

test('the registered tool names equal toolNames() and the descriptions come from the catalog', async (t) => {
  const f = await fixture(t);
  const tools = await listed(f.options);
  assert.deepEqual(tools.map(({ name }) => name).sort(), toolNames().sort());
  for (const tool of tools) {
    const summary = OPERATIONS.find(({ tool: name }) => name === tool.name).summary;
    if (tool.name === 'wiki_query') assert.ok(tool.description.startsWith(summary));
    else assert.equal(tool.description, summary);
  }
  const readOnly = await listed((await fixture(t, { readOnly: true })).options);
  assert.deepEqual(
    readOnly.map(({ name }) => name).sort(),
    OPERATIONS.filter(({ kind }) => kind === 'read')
      .map(({ tool }) => tool)
      .sort()
  );
});

test('wiki_create keeps the old entity and concept behaviour, including errors', async (t) => {
  const f = await fixture(t);
  const entity = await ok(f.options, 'wiki_create', {
    type: 'entity',
    name: 'New Entity',
    content: '---\nsummary: A summary\n---\nBody.',
  });
  assert.deepEqual(entity, { path: 'wiki/entities/new-entity.md', created: true });
  const concept = await ok(f.options, 'wiki_create', {
    type: 'concept',
    name: 'New Concept',
    content: 'Concept body.',
  });
  assert.deepEqual(concept, { path: 'wiki/concepts/new-concept.md', created: true });
  const entityFile = await readFile(join(f.vault, 'wiki/entities/new-entity.md'), 'utf8');
  assert.match(entityFile, /^type: entity$/m);
  assert.match(entityFile, /^title: New Entity$/m);
  assert.match(entityFile, /^summary: A summary$/m);
  assert.match(entityFile, /^generated: /m);
  const index = await readFile(join(f.vault, 'wiki/index.md'), 'utf8');
  assert.match(index, /- \[New Entity\]\(entities\/new-entity\.md\) — A summary/u);
  assert.match(index, /- \[New Concept\]\(concepts\/new-concept\.md\)/u);
  const log = await readFile(join(f.vault, 'wiki/log.md'), 'utf8');
  assert.match(log, /"action":"create-entity"/u);
  assert.match(log, /"action":"create-concept"/u);
  assert.match(
    await failed(f.options, 'wiki_create', { type: 'entity', name: 'New Entity', content: 'x' }),
    /E_ALREADY_EXISTS/
  );
  assert.match(
    await failed(f.options, 'wiki_create', { type: 'entity', name: '!!!', content: 'x' }),
    /E_INVALID_INPUT/
  );
});

test('create, update and link run dry without writing a page, index, log line or lock file', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.vault, 'wiki/linked.md'), '---\ntype: concept\ntitle: Linked\n---\nBody.\n');
  await writeFile(join(f.vault, 'wiki/source.md'), '---\ntype: concept\ntitle: Source\n---\n[Linked](linked.md)\n');
  const before = {
    index: await readFile(join(f.vault, 'wiki/index.md'), 'utf8'),
    log: await readFile(join(f.vault, 'wiki/log.md'), 'utf8'),
    source: await readFile(join(f.vault, 'wiki/source.md'), 'utf8'),
  };
  const dry = { ...f.options, dryRun: true };
  const created = await ok(dry, 'wiki_create', { type: 'entity', name: 'Dry', content: 'x' });
  assert.equal(created.dryRun, true);
  const updated = await ok(dry, 'wiki_update_page', { path: 'source.md', patch: { append: '\nMore.' } });
  assert.equal(updated.dryRun, true);
  assert.equal(updated.sha256, undefined);
  const linked = await ok(dry, 'wiki_add_crosslinks', { path: 'source.md' });
  assert.deepEqual(linked, { path: 'wiki/source.md', linked: 1, dryRun: true });
  assert.equal(await readFile(join(f.vault, 'wiki/index.md'), 'utf8'), before.index);
  assert.equal(await readFile(join(f.vault, 'wiki/log.md'), 'utf8'), before.log);
  assert.equal(await readFile(join(f.vault, 'wiki/source.md'), 'utf8'), before.source);
  await assert.rejects(readFile(join(f.vault, 'wiki/entities/dry.md')), { code: 'ENOENT' });
});

test('adapters, hooks and the policy template name only catalog tools, and the skill lists every cli form', async (t) => {
  const root = resolve('.');
  const files = [
    'packages/adapters/claude-code/src/index.mjs',
    'packages/adapters/codex/src/index.mjs',
    'packages/adapters/copilot-vscode/src/index.mjs',
    'packages/adapters/gemini-cli/src/index.mjs',
    'packages/adapters/kiro/src/index.mjs',
    'packages/hooks/src/index.mjs',
    'templates/policy/AGENTS.md',
    ...(await readdir(join(root, 'docs/user'))).map((name) => `docs/user/${name}`),
  ];
  const names = new Set(toolNames());
  for (const file of files) {
    const text = await readFile(join(root, file), 'utf8');
    for (const token of text.match(/\b(?:wiki|plan)_[a-z0-9_]+\b/gu) ?? []) {
      assert.ok(names.has(token), `${file} mentions ${token}, which is not in toolNames()`);
    }
  }

  const base = await mkdtemp(join(tmpdir(), 'ba93-skill-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = join(base, 'home');
  const shimPath = join(base, 'bin', 'brainatlas');
  await mkdir(home, { recursive: true });
  await mkdir(dirname(shimPath), { recursive: true });
  await writeFile(shimPath, 'shim');
  const { plan } = await import('../../packages/adapters/claude-code/src/index.mjs');
  const change = plan({
    env: { HOME: home },
    platform: 'linux',
    scope: 'global',
    nodePath: '/opt/node',
    shimPath,
    config: { channel: 'cli' },
    paths: { stateDir: join(base, 'state') },
  }).changes.find(({ file }) => file.endsWith('SKILL.md'));
  assert.ok(change, 'the cli channel writes a skill');
  for (const cli of cliCommands()) assert.ok(change.after.includes(cli), `skill is missing ${cli}`);
  assert.ok(change.after.includes('## Retrieve'));
  assert.ok(change.after.includes('## Capture'));
  assert.equal(change.after.includes('wiki index'), false);

  const readonlyChange = plan({
    env: { HOME: home },
    platform: 'linux',
    scope: 'global',
    nodePath: '/opt/node',
    shimPath,
    config: { channel: 'cli', readOnly: true },
    paths: { stateDir: join(base, 'state') },
  }).changes.find(({ file }) => file.endsWith('SKILL.md'));
  assert.ok(readonlyChange, 'the readOnly cli channel writes a skill');
  for (const { cli, kind } of OPERATIONS) {
    if (kind === 'read') assert.ok(readonlyChange.after.includes(cli), `readOnly skill is missing ${cli}`);
    else assert.equal(readonlyChange.after.includes(cli), false, `readOnly skill teaches ${cli}`);
  }
  assert.equal(readonlyChange.after.includes('wiki index'), false);
});

test('kiro recognises the rc.18 autoApprove list, warns once and refreshes it to the catalog read tools', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'ba93-kiro-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = join(base, 'home');
  const shimPath = join(base, 'bin', 'brainatlas');
  await mkdir(join(home, '.kiro/settings'), { recursive: true });
  await mkdir(dirname(shimPath), { recursive: true });
  await writeFile(shimPath, 'shim');
  const legacy = ['wiki_query', 'wiki_read_page', 'wiki_read_index', 'wiki_list_pages', 'wiki_status'];
  const file = join(home, '.kiro/settings/mcp.json');
  await writeFile(
    file,
    `${JSON.stringify(
      {
        mcpServers: {
          brainatlas: {
            command: '/opt/node',
            args: [shimPath, 'mcp'],
            env: {},
            disabled: false,
            autoApprove: legacy,
          },
        },
      },
      null,
      2
    )}\n`
  );
  const kiro = await import('../../packages/adapters/kiro/src/index.mjs');
  const ctx = {
    env: { HOME: home },
    platform: 'linux',
    scope: 'global',
    nodePath: '/opt/node',
    shimPath,
    config: { channel: 'mcp' },
    paths: { stateDir: join(base, 'state') },
  };
  const report = await kiro.doctor(ctx);
  assert.ok(
    report.warnings.includes('Kiro MCP autoApprove list is from an older release; run brainatlas agent refresh kiro.')
  );
  const planned = await kiro.plan(ctx);
  const change = planned.changes.find((item) => item.file === file);
  assert.ok(change, 'refresh rewrites the MCP entry');
  assert.deepEqual(JSON.parse(change.after).mcpServers.brainatlas.autoApprove, [
    'wiki_query',
    'wiki_read_page',
    'wiki_list_pages',
    'wiki_status',
  ]);
  await kiro.apply(planned, ctx);
  assert.equal((await kiro.doctor(ctx)).warnings.length, 0);
});
