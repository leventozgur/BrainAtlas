// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { defaultConfig } from '../../packages/core/src/config/index.mjs';
import { OPERATIONS, toolNames } from '../../packages/core/src/index.mjs';
import { cleanEnv } from './clean-env.mjs';

const BIN = resolve('packages/cli/bin/brainatlas.mjs');

const page = (title, body = 'Body.') =>
  `---\ntype: concept\ntitle: ${JSON.stringify(title)}\ngenerated: "2026-11-01"\nstatus: proposed\n---\n\n# ${title}\n\n${body}\n`;

async function write(dir, rel, text) {
  const file = join(dir, rel);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text);
}

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'ba93-wiki-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = join(base, 'home');
  const vault = join(base, 'vault');
  await mkdir(home, { recursive: true });
  await write(vault, 'wiki/index.md', '# Wiki Index\n\n## Concepts\n\n- [Alpha](concepts/alpha.md)\n');
  await write(vault, 'wiki/log.md', '# Log\n');
  await write(vault, 'wiki/concepts/alpha.md', page('Alpha', 'alpha body.\n'));
  await write(vault, 'wiki/concepts/other.md', page('Other', 'other body.\n'));
  await write(vault, 'wiki/concepts/source.md', page('Source', '[Other](other.md)\n'));
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
  const run = (args, options = {}) =>
    spawnSync(process.execPath, [BIN, 'wiki', ...args], {
      env: options.env ?? env,
      input: options.input,
      encoding: 'utf8',
      shell: false,
      timeout: 15000,
    });
  const json = (args, options = {}) => {
    const result = run([...args, '--json'], options);
    assert.equal(result.error, undefined, 'command timed out');
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, value: JSON.parse(result.stdout) };
  };
  return { base, home, vault, env, run, json };
}

async function readOnlyEnv(t, f) {
  const config = defaultConfig('lite');
  config.vault.path = f.vault;
  config.readOnly = true;
  const file = join(f.home, 'brainatlas.json');
  await writeFile(file, JSON.stringify(config));
  return { ...f.env, BRAINATLAS_CONFIG: file };
}

test('wiki subcommands are the catalog operations and wiki index is an argument error', () => {
  const subcommands = OPERATIONS.filter(({ cli }) => cli.startsWith('wiki ')).map(({ cli }) => cli.split(' ')[1]);
  assert.deepEqual(subcommands, [
    'query',
    'read',
    'list',
    'status',
    'lint',
    'write',
    'update',
    'create',
    'link',
    'reindex',
  ]);
  const message = `wiki requires one of: ${subcommands.join(', ')}.`;
  for (const argv of [['bogus'], ['index'], []]) {
    const result = spawnSync(process.execPath, [BIN, 'wiki', ...argv, '--json'], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.deepEqual(JSON.parse(result.stdout).error, { code: 'E_ARGUMENT', message });
  }
});

test('wiki create writes the page, index line and create log action; dry run changes nothing', async (t) => {
  const f = await fixture(t);
  const dry = f.json(['create', 'entity', 'Dry Entity', '--dry-run'], { input: 'Dry body.' });
  assert.equal(dry.status, 0, dry.stderr);
  assert.deepEqual(dry.value, { ok: true, path: 'wiki/entities/dry-entity.md', created: true, dryRun: true });
  await assert.rejects(readFile(join(f.vault, 'wiki/entities/dry-entity.md')), { code: 'ENOENT' });

  const created = f.json(['create', 'concept', 'New Concept'], { input: 'Body text.\n' });
  assert.equal(created.status, 0, created.stderr);
  assert.deepEqual(created.value, { ok: true, path: 'wiki/concepts/new-concept.md', created: true, dryRun: false });
  const text = await readFile(join(f.vault, 'wiki/concepts/new-concept.md'), 'utf8');
  assert.match(text, /^title: New Concept$/m);
  assert.match(text, /^type: concept$/m);
  assert.match(
    await readFile(join(f.vault, 'wiki/index.md'), 'utf8'),
    /- \[New Concept\]\(concepts\/new-concept\.md\)/u
  );
  assert.match(await readFile(join(f.vault, 'wiki/log.md'), 'utf8'), /"action":"create-concept"/u);
  assert.equal(f.run(['create', 'concept'], { input: 'x' }).status, 1);
  assert.equal(f.run(['create', 'other', 'Name'], { input: 'x' }).status, 1);
});

test('wiki update sends body, append and frontmatter through the patch and supports dry run', async (t) => {
  const f = await fixture(t);
  const body = f.json(['update', 'concepts/alpha.md'], { input: 'New body.\n' });
  assert.equal(body.status, 0, body.stderr);
  assert.deepEqual(body.value, { ok: true, path: 'wiki/concepts/alpha.md', updated: true, dryRun: false });
  let text = await readFile(join(f.vault, 'wiki/concepts/alpha.md'), 'utf8');
  assert.match(text, /New body\./u);
  assert.doesNotMatch(text, /alpha body\./u);

  const appended = f.json(['update', 'concepts/alpha.md', '--append', '--frontmatter-json', '{"status":"confirmed"}'], {
    input: '\nAppended.\n',
  });
  assert.equal(appended.status, 0, appended.stderr);
  text = await readFile(join(f.vault, 'wiki/concepts/alpha.md'), 'utf8');
  assert.match(text, /New body\.[\s\S]*Appended\./u);
  assert.match(text, /^status: confirmed$/m);

  const before = await readFile(join(f.vault, 'wiki/concepts/alpha.md'), 'utf8');
  const logBefore = await readFile(join(f.vault, 'wiki/log.md'), 'utf8');
  const dry = f.json(['update', 'concepts/alpha.md', '--append', '--dry-run'], { input: 'Nope.\n' });
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(dry.value.dryRun, true);
  assert.equal(await readFile(join(f.vault, 'wiki/concepts/alpha.md'), 'utf8'), before);
  assert.equal(await readFile(join(f.vault, 'wiki/log.md'), 'utf8'), logBefore);
  const badJson = f.json(['update', 'concepts/alpha.md', '--frontmatter-json', '[]'], { input: 'x' });
  assert.equal(badJson.status, 1);
  assert.equal(badJson.value.error.code, 'E_ARGUMENT');
});

test('wiki link adds the crosslinks section and supports dry run', async (t) => {
  const f = await fixture(t);
  const before = await readFile(join(f.vault, 'wiki/concepts/source.md'), 'utf8');
  const dry = f.json(['link', 'concepts/source.md', '--dry-run']);
  assert.equal(dry.status, 0, dry.stderr);
  assert.deepEqual(dry.value, { ok: true, path: 'wiki/concepts/source.md', linked: 1, dryRun: true });
  assert.equal(await readFile(join(f.vault, 'wiki/concepts/source.md'), 'utf8'), before);
  const linked = f.json(['link', 'concepts/source.md']);
  assert.equal(linked.status, 0, linked.stderr);
  assert.deepEqual(linked.value, { ok: true, path: 'wiki/concepts/source.md', linked: 1, dryRun: false });
  assert.match(await readFile(join(f.vault, 'wiki/concepts/source.md'), 'utf8'), /## See also/u);
});

test('readOnly refuses update, create and link before stdin; the new subcommands have the write stdin rules', async (t) => {
  const f = await fixture(t);
  const env = await readOnlyEnv(t, f);
  for (const args of [
    ['update', 'concepts/alpha.md'],
    ['create', 'entity', 'RO'],
    ['link', 'concepts/source.md'],
  ]) {
    const result = f.json(args, { env });
    assert.equal(result.status, 1, args.join(' '));
    assert.deepEqual(result.value.error, { code: 'E_READ_ONLY', message: 'The vault is read-only (readOnly: true).' });
  }
  for (const args of [['update', 'concepts/alpha.md']]) {
    const result = f.json(args, { input: '  \n' });
    assert.equal(result.status, 1);
    assert.equal(result.value.error.code, 'E_ARGUMENT');
    assert.equal(result.value.error.message, `wiki ${args[0]} requires page content on standard input.`);
  }
  const large = f.json(['create', 'entity', 'Large'], { input: 'a'.repeat(1_048_577) });
  assert.equal(large.value.error.message, 'Page content is larger than 1 MiB.');
});

test('help and the MCP tool list describe the same catalog', async (t) => {
  const f = await fixture(t);
  const help = spawnSync(process.execPath, [BIN, '--help', '--json'], {
    env: f.env,
    encoding: 'utf8',
    shell: false,
    timeout: 15000,
  });
  assert.equal(help.status, 0, help.stderr);
  const command = JSON.parse(help.stdout).commands.find(({ name }) => name === 'wiki');
  assert.match(command.description, /update, create, link and reindex/u);
  assert.doesNotMatch(command.usage, /wiki index/u);
  for (const form of ['update <path>', 'create <entity|concept> <name...>', 'link <path>']) {
    assert.ok(command.usage.includes(form), `usage is missing ${form}`);
  }
  assert.ok(toolNames().every((name) => /^wiki_|^plan_/u.test(name)));
  const names = await readdir(join(f.vault, 'wiki'));
  assert.ok(!names.some((name) => name.includes('tmp') || name.includes('lock')));
});
