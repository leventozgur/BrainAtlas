// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { cleanEnv } from './clean-env.mjs';

const BIN = resolve('packages/cli/bin/brainatlas.mjs');
const MIXED = ['init', '--yes', '--agents', 'claude-code,kiro'];

async function tree(root) {
  const out = {};
  async function visit(dir, rel) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(join(dir, entry.name), childRel);
      else out[childRel] = await readFile(join(dir, entry.name), 'utf8');
    }
  }
  await visit(root, '');
  return out;
}

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'ba61-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = join(base, 'home');
  const vault = join(base, 'vault');
  await mkdir(join(vault, 'wiki'), { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFile(join(vault, 'wiki', 'index.md'), '# Wiki Index\n');
  await writeFile(join(vault, 'wiki', 'log.md'), '# Log\n');
  const env = cleanEnv({
    HOME: home,
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_DATA_HOME: join(home, 'data'),
    XDG_STATE_HOME: join(home, 'state'),
    BRAINATLAS_PLATFORM: 'linux',
    BRAINATLAS_OFFLINE: '1',
    PATH: process.env.PATH || '/usr/bin:/bin',
  });
  const configFile = join(home, 'config', 'brainatlas', 'config.json');
  const run = (...args) =>
    spawnSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8', shell: false, timeout: 30000 });
  const json = (...args) => {
    const result = run(...args, '--json');
    assert.equal(result.error, undefined);
    let value;
    try {
      value = JSON.parse(result.stdout);
    } catch {
      value = null;
    }
    return { result, value };
  };
  return { home, vault, configFile, run, json };
}

const exists = (file) =>
  stat(file).then(
    () => true,
    () => false
  );
const adapterFiles = async (home, rels) =>
  Object.fromEntries(
    await Promise.all(rels.map(async (r) => [r, await readFile(join(home, r), 'utf8').catch(() => null)]))
  );
const KIRO = ['.kiro/steering/brainatlas.md', '.kiro/settings/mcp.json', '.kiro/hooks/brainatlas.json'];

test('mixed install writes cli files for claude-code and mcp files for kiro', async (t) => {
  const f = await fixture(t);
  const { result } = f.json(...MIXED, '--vault', f.vault, '--channel', 'claude-code=cli');
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(await readFile(f.configFile, 'utf8'));
  assert.deepEqual(config.channels, { 'claude-code': 'cli' });
  assert.equal(config.channel, undefined);
  assert.ok(await exists(join(f.home, '.claude', 'skills', 'brainatlas', 'SKILL.md')));
  assert.equal(await exists(join(f.home, '.claude.json')), false);
  assert.equal(await exists(join(f.home, '.claude', 'settings.json')), false);
  const kiro = await adapterFiles(f.home, KIRO);
  assert.match(kiro['.kiro/settings/mcp.json'], /brainatlas/);
  assert.ok(kiro['.kiro/hooks/brainatlas.json']);
});

test('explicit kiro=mcp is byte-identical to no --channel', async (t) => {
  const a = await fixture(t);
  const b = await fixture(t);
  assert.equal(a.json(...MIXED, '--vault', a.vault).result.status, 0);
  assert.equal(b.json(...MIXED, '--vault', b.vault, '--channel', 'kiro=mcp').result.status, 0);
  const rels = [...KIRO, 'CLAUDE.md', '.claude.json', '.claude/settings.json'];
  const strip = (files, home) => JSON.stringify(files).replaceAll(home, '<home>');
  assert.equal(strip(await adapterFiles(a.home, rels), a.home), strip(await adapterFiles(b.home, rels), b.home));
  assert.deepEqual(JSON.parse(await readFile(b.configFile, 'utf8')).channels, { kiro: 'mcp' });
});

test('--plan with pairs reports adapter changes and writes nothing', async (t) => {
  const f = await fixture(t);
  const { result, value } = f.json(...MIXED, '--vault', f.vault, '--channel', 'claude-code=cli', '--plan');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(value.config.changes.channels, { from: null, to: { 'claude-code': 'cli' } });
  const files = value.adapters.flatMap((item) => item.changes.map((change) => change.file));
  assert.ok(files.some((file) => file.endsWith('skills/brainatlas/SKILL.md')));
  assert.ok(files.some((file) => file.endsWith('.kiro/settings/mcp.json')));
  assert.ok(!files.some((file) => file.endsWith('.claude.json')));
  assert.deepEqual(await tree(f.home), {});
});

test('switch guard: changing an installed agent channel needs uninstall', async (t) => {
  const f = await fixture(t);
  assert.equal(f.json(...MIXED, '--vault', f.vault, '--channel', 'claude-code=cli').result.status, 0);
  const before = await tree(f.home);
  for (const channel of ['claude-code=mcp', 'kiro=cli', 'cli']) {
    const { result, value } = f.json('init', '--channel', channel);
    assert.notEqual(result.status, 0, channel);
    assert.match(JSON.stringify(value) + result.stderr, /E_CHANNEL_SWITCH|uninstall/);
  }
  assert.deepEqual(await tree(f.home), before);
  assert.equal(f.json('init', '--channel', 'claude-code=cli', '--plan').result.status, 0);
});

test('invalid pairs are rejected with E_ARGUMENT', async (t) => {
  const f = await fixture(t);
  for (const channel of [
    'claude-code',
    'claude-code=',
    '=cli',
    'claude-code=shell',
    'nope=cli',
    'codex=cli',
    'kiro=cli,kiro=mcp',
    'kiro=cli,',
  ]) {
    const { result, value } = f.json(...MIXED, '--vault', f.vault, '--channel', channel);
    assert.notEqual(result.status, 0, channel);
    assert.match(JSON.stringify(value) + result.stderr, /E_ARGUMENT/, channel);
  }
  assert.equal(await exists(f.configFile), false);
});

test('whitespace around pairs is trimmed', async (t) => {
  const f = await fixture(t);
  const { result } = f.json(...MIXED, '--vault', f.vault, '--channel', ' claude-code = cli , kiro = mcp ');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(await readFile(f.configFile, 'utf8')).channels, { 'claude-code': 'cli', kiro: 'mcp' });
});

test('config set/unset of channels is rejected and writes nothing', async (t) => {
  const f = await fixture(t);
  assert.equal(f.json(...MIXED, '--vault', f.vault, '--channel', 'claude-code=cli').result.status, 0);
  const before = await readFile(f.configFile, 'utf8');
  for (const args of [
    ['set', 'channels.kiro', 'cli'],
    ['set', 'channels', '{}'],
    ['unset', 'channels.claude-code'],
    ['unset', 'channels'],
  ]) {
    const { result, value } = f.json('config', ...args);
    assert.notEqual(result.status, 0, args.join(' '));
    assert.match(JSON.stringify(value) + result.stderr, /E_CHANNEL_SWITCH/);
  }
  assert.equal(await readFile(f.configFile, 'utf8'), before);
});

test('status reports agentChannels', async (t) => {
  const f = await fixture(t);
  assert.equal(f.json(...MIXED, '--vault', f.vault, '--channel', 'claude-code=cli').result.status, 0);
  const { value } = f.json('status');
  assert.deepEqual(value.agentChannels, { 'claude-code': 'cli', kiro: 'mcp' });
});

test('uninstall of a mixed install removes both adapters files', async (t) => {
  const f = await fixture(t);
  assert.equal(f.json(...MIXED, '--vault', f.vault, '--channel', 'claude-code=cli').result.status, 0);
  const { result } = f.json('uninstall');
  assert.equal(result.status, 0, result.stderr);
  for (const rel of ['.claude/skills/brainatlas/SKILL.md', ...KIRO])
    assert.equal(await exists(join(f.home, rel)), false, rel);
  const claude = await readFile(join(f.home, 'CLAUDE.md'), 'utf8').catch(() => '');
  assert.ok(!claude.includes('brainatlas'));
});
