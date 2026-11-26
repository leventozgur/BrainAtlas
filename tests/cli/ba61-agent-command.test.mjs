// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
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
const withoutBackups = (files) => Object.fromEntries(Object.entries(files).filter(([name]) => !/\.bak\./.test(name)));
const pick = (files, prefixes) =>
  Object.fromEntries(Object.entries(files).filter(([name]) => prefixes.some((prefix) => name.startsWith(prefix))));

async function fixture(t, extraPath) {
  const base = await mkdtemp(join(tmpdir(), 'ba61a-'));
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
    PATH: extraPath ?? (process.env.PATH || '/usr/bin:/bin'),
  });
  const configFile = join(home, 'config', 'brainatlas', 'config.json');
  const json = (...args) => {
    const result = spawnSync(process.execPath, [BIN, ...args, '--json'], {
      env,
      encoding: 'utf8',
      shell: false,
      timeout: 30000,
    });
    assert.equal(result.error, undefined);
    let value = null;
    try {
      value = JSON.parse(result.stdout);
      // eslint-disable-next-line no-empty
    } catch {}
    return { result, value };
  };
  const ok = (...args) => {
    const out = json(...args);
    assert.equal(out.result.status, 0, out.result.stderr + out.result.stdout);
    return out.value;
  };
  const fail = (code, ...args) => {
    const { result, value } = json(...args);
    assert.notEqual(result.status, 0, args.join(' '));
    assert.match(JSON.stringify(value) + result.stderr, new RegExp(code), args.join(' '));
  };
  return { home, vault, configFile, json, ok, fail };
}

async function controlledBin(t) {
  const bin = await mkdtemp(join(tmpdir(), 'ba61-bin-'));
  t.after(() => rm(bin, { recursive: true, force: true }));
  await symlink(process.execPath, join(bin, 'node'));
  return bin;
}

const exists = (file) =>
  stat(file).then(
    () => true,
    () => false
  );
const CLAUDE = ['.claude', 'CLAUDE.md', '.claude.json'];
const KIRO = ['.kiro'];

test('list reports installed agents, channels and health', async (t) => {
  const f = await fixture(t, await controlledBin(t));
  f.ok(...MIXED, '--vault', f.vault, '--channel', 'claude-code=cli');
  const before = await tree(f.home);
  const value = f.ok('agent', 'list');
  assert.equal(value.action, 'agent-list');
  assert.deepEqual(
    value.agents.map((a) => a.agent),
    ['claude-code', 'codex', 'copilot-vscode', 'gemini-cli', 'kiro']
  );
  const by = Object.fromEntries(value.agents.map((a) => [a.agent, a]));
  assert.equal(by['claude-code'].installed, true);
  assert.equal(by['claude-code'].channel, 'cli');
  assert.equal(by.kiro.channel, 'mcp');
  assert.equal(typeof by.kiro.healthy, 'boolean');
  assert.deepEqual(by.codex, {
    agent: 'codex',
    installed: false,
    channel: null,
    healthy: null,
    detected: false,
    evidence: [],
  });
  assert.deepEqual(await tree(f.home), before);
});

test('add and remove kiro leave claude-code untouched', async (t) => {
  const f = await fixture(t);
  f.ok('init', '--yes', '--agents', 'claude-code', '--vault', f.vault);
  const claude = pick(withoutBackups(await tree(f.home)), CLAUDE);
  const plan = f.ok('agent', 'add', 'kiro', '--channel', 'cli', '--plan');
  assert.equal(plan.agent, 'kiro');
  assert.ok(plan.changes);
  assert.equal(await exists(join(f.home, '.kiro')), false);
  assert.deepEqual(JSON.parse(await readFile(f.configFile, 'utf8')).agents, ['claude-code']);
  const added = f.ok('agent', 'add', 'kiro', '--channel', 'cli');
  assert.deepEqual(added, { action: 'agent-add', agent: 'kiro', channel: 'cli' });
  const config = JSON.parse(await readFile(f.configFile, 'utf8'));
  assert.deepEqual(config.agents, ['claude-code', 'kiro']);
  assert.deepEqual(config.channels, { kiro: 'cli' });
  assert.ok(await exists(join(f.home, '.kiro')));
  assert.deepEqual(pick(withoutBackups(await tree(f.home)), CLAUDE), claude);
  const removePlan = f.ok('agent', 'remove', 'kiro', '--plan');
  assert.equal(removePlan.agent, 'kiro');
  assert.deepEqual(JSON.parse(await readFile(f.configFile, 'utf8')).agents, ['claude-code', 'kiro']);
  assert.deepEqual(f.ok('agent', 'remove', 'kiro'), { action: 'agent-remove', agent: 'kiro' });
  const after = JSON.parse(await readFile(f.configFile, 'utf8'));
  assert.deepEqual(after.agents, ['claude-code']);
  assert.equal('channels' in after, false);
  assert.deepEqual(pick(withoutBackups(await tree(f.home)), CLAUDE), claude);
});

test('set claude-code mcp -> cli -> mcp round trip restores bytes and keeps kiro', async (t) => {
  const f = await fixture(t);
  f.ok(...MIXED, '--vault', f.vault);
  const initial = withoutBackups(await tree(f.home));
  const claude = pick(initial, CLAUDE);
  const kiro = pick(initial, KIRO);
  assert.ok(Object.keys(claude).length > 0);
  const toCli = f.ok('agent', 'set', 'claude-code', '--channel', 'cli');
  assert.deepEqual(toCli, { action: 'agent-set', agent: 'claude-code', from: 'mcp', to: 'cli', changed: true });
  const mid = withoutBackups(await tree(f.home));
  assert.ok(await exists(join(f.home, '.claude', 'skills', 'brainatlas', 'SKILL.md')));
  assert.equal(await exists(join(f.home, '.claude.json')), false);
  assert.deepEqual(pick(mid, KIRO), kiro);
  assert.equal(f.ok('agent', 'list').agents[0].channel, 'cli');
  const back = f.ok('agent', 'set', 'claude-code', '--channel', 'mcp');
  assert.equal(back.changed, true);
  const final = withoutBackups(await tree(f.home));
  assert.deepEqual(pick(final, CLAUDE), claude);
  assert.deepEqual(pick(final, KIRO), kiro);
});

test('set to the current channel is a no-op and writes nothing', async (t) => {
  const f = await fixture(t);
  f.ok(...MIXED, '--vault', f.vault);
  const home = await tree(f.home);
  const value = f.ok('agent', 'set', 'kiro', '--channel', 'mcp');
  assert.deepEqual(value, { action: 'agent-set', agent: 'kiro', from: 'mcp', to: 'mcp', changed: false });
  assert.deepEqual(await tree(f.home), home);
});

test('set --plan reports remove and install and writes nothing', async (t) => {
  const f = await fixture(t);
  f.ok(...MIXED, '--vault', f.vault);
  const home = await tree(f.home);
  const value = f.ok('agent', 'set', 'claude-code', '--channel', 'cli', '--plan');
  assert.equal(value.changed, true);
  assert.ok(value.remove);
  assert.ok(value.install);
  assert.ok(!JSON.stringify(value).includes(f.home));
  assert.deepEqual(await tree(f.home), home);
});

test('error cases', async (t) => {
  const f = await fixture(t);
  f.ok(...MIXED, '--vault', f.vault);
  const home = await tree(f.home);
  assert.equal(f.ok('agent', 'list').agents.filter((a) => a.installed).length, 2);
  f.fail('E_AGENT_UNKNOWN', 'agent', 'add', 'nope');
  f.fail('E_ARGUMENT', 'agent', 'add', 'kiro');
  f.fail('E_ARGUMENT', 'agent', 'add', 'codex', '--channel', 'shell');
  f.fail('E_ARGUMENT', 'agent', 'remove', 'codex');
  f.fail('E_ARGUMENT', 'agent', 'set', 'codex', '--channel', 'cli');
  f.fail('E_ARGUMENT', 'agent', 'set', 'kiro');
  f.fail('E_ARGUMENT', 'agent', 'set', 'kiro', '--channel', 'shell');
  f.fail('E_ARGUMENT', 'agent', 'frobnicate');
  f.fail('E_ARGUMENT', 'agent');
  assert.deepEqual(await tree(f.home), home);
  await writeFile(f.configFile, '{ not json');
  f.fail('E_CONFIG_PARSE', 'agent', 'list');
});

test('uninstall after agent add removes the added agent files', async (t) => {
  const f = await fixture(t);
  f.ok('init', '--yes', '--agents', 'claude-code', '--vault', f.vault);
  f.ok('agent', 'add', 'kiro');
  assert.ok(await exists(join(f.home, '.kiro', 'settings', 'mcp.json')));
  f.ok('uninstall');
  for (const rel of ['.kiro/steering/brainatlas.md', '.kiro/settings/mcp.json', '.kiro/hooks/brainatlas.json'])
    assert.equal(await exists(join(f.home, rel)), false, rel);
});

test('add, remove and set need an initialized config', async (t) => {
  const f = await fixture(t);
  for (const args of [
    ['agent', 'add', 'kiro'],
    ['agent', 'add', 'kiro', '--plan'],
    ['agent', 'remove', 'kiro'],
    ['agent', 'set', 'kiro', '--channel', 'cli'],
  ])
    f.fail('Run brainatlas init first', ...args);
  assert.deepEqual(await tree(f.home), {});
});

const ownedBy = async (home, agent) => {
  const files = await tree(home);
  const name = Object.keys(files).find((file) => /install-manifest|manifest\.json$/.test(file));
  if (!name) return null;
  return (JSON.parse(files[name]).files || []).filter((entry) => entry.owners?.includes(agent));
};

test('uninstall after agent add leaves no manifest entries owned by the agent', async (t) => {
  const f = await fixture(t);
  f.ok('init', '--yes', '--agents', 'claude-code', '--vault', f.vault);
  f.ok('agent', 'add', 'kiro');
  assert.ok((await ownedBy(f.home, 'kiro')).length > 0);
  f.ok('uninstall');
  assert.deepEqual((await ownedBy(f.home, 'kiro')) ?? [], []);
});

test('remove --plan lists the files the agent owns and writes nothing', async (t) => {
  const f = await fixture(t);
  f.ok(...MIXED, '--vault', f.vault);
  const home = await tree(f.home);
  const value = f.ok('agent', 'remove', 'kiro', '--plan');
  const files = value.changes.changes.map((change) => change.file);
  assert.ok(files.some((file) => file.endsWith('.kiro/settings/mcp.json')));
  assert.ok(files.some((file) => file.endsWith('.kiro/hooks/brainatlas.json')));
  assert.ok(files.every((file) => !file.includes(f.home)));
  assert.equal(new Set(files).size, files.length);
  const set = f.ok('agent', 'set', 'kiro', '--channel', 'cli', '--plan');
  assert.ok(set.remove.changes.some((change) => change.file.endsWith('.kiro/settings/mcp.json')));
  assert.equal(set.installApproximate, true);
  assert.deepEqual(await tree(f.home), home);
});

test('set stores the requested channel, also with an existing entry and when returning to mcp', async (t) => {
  const f = await fixture(t);
  f.ok(...MIXED, '--vault', f.vault, '--channel', 'kiro=mcp');
  const channels = async () => JSON.parse(await readFile(f.configFile, 'utf8')).channels;
  assert.deepEqual(await channels(), { kiro: 'mcp' });
  f.ok('agent', 'set', 'kiro', '--channel', 'cli');
  assert.deepEqual(await channels(), { kiro: 'cli' });
  f.ok('agent', 'set', 'claude-code', '--channel', 'cli');
  assert.deepEqual(await channels(), { kiro: 'cli', 'claude-code': 'cli' });
  f.ok('agent', 'set', 'kiro', '--channel', 'mcp');
  assert.deepEqual(await channels(), { kiro: 'mcp', 'claude-code': 'cli' });
});

test('failed switch restores the previous channel and keeps the config', async (t) => {
  const f = await fixture(t);
  f.ok(...MIXED, '--vault', f.vault);
  await writeFile(join(f.home, '.claude', 'skills'), 'not a directory');
  const config = await readFile(f.configFile, 'utf8');
  const before = withoutBackups(await tree(f.home));
  const { result, value } = f.json('agent', 'set', 'claude-code', '--channel', 'cli');
  assert.notEqual(result.status, 0);
  assert.match(JSON.stringify(value) + result.stderr, /E_AGENT_SWITCH/);
  assert.match(JSON.stringify(value) + result.stderr, /previous channel was restored/);
  assert.equal(await readFile(f.configFile, 'utf8'), config);
  assert.ok(await exists(join(f.home, '.claude.json')));
  assert.deepEqual(pick(withoutBackups(await tree(f.home)), CLAUDE), pick(before, CLAUDE));
});

test('list shows evidence-based detection from HOME and PATH', async (t) => {
  const bin = await controlledBin(t);
  await writeFile(join(bin, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const f = await fixture(t, bin);
  await mkdir(join(f.home, '.kiro'));
  const before = await tree(f.home);
  const by = Object.fromEntries(f.ok('agent', 'list').agents.map((a) => [a.agent, a]));
  assert.deepEqual(by.kiro.evidence, ['~/.kiro']);
  assert.equal(by.kiro.detected, true);
  assert.deepEqual(by['claude-code'].evidence, ['PATH:claude']);
  assert.equal(by['claude-code'].detected, true);
  assert.deepEqual(by.codex, {
    agent: 'codex',
    installed: false,
    channel: null,
    healthy: null,
    detected: false,
    evidence: [],
  });
  assert.equal(by.kiro.installed, false);
  assert.deepEqual(await tree(f.home), before);
});

test('init suggests detectedAgents only without agents and never installs them', async (t) => {
  const bin = await controlledBin(t);
  await writeFile(join(bin, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const f = await fixture(t, bin);
  await mkdir(join(f.home, '.kiro'));
  const planned = f.ok('init', '--yes', '--plan', '--vault', f.vault);
  assert.deepEqual(planned.detectedAgents, ['claude-code', 'kiro']);
  const real = f.ok('init', '--yes', '--vault', f.vault);
  assert.deepEqual(real.detectedAgents, ['claude-code', 'kiro']);
  assert.deepEqual(JSON.parse(await readFile(f.configFile, 'utf8')).agents, []);
  assert.equal(await exists(join(f.home, '.claude')), false);
  const withAgents = f.ok('init', '--yes', '--agents', 'kiro', '--vault', f.vault);
  assert.equal('detectedAgents' in withAgents, false);
});
