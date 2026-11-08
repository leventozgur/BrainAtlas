// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import * as adapter from '../../../packages/adapters/codex/src/index.mjs';

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ba-codex-config-'));
  const home = path.join(root, 'home');
  await mkdir(path.join(home, '.codex'), { recursive: true });
  const ctx = {
    env: { HOME: home, XDG_STATE_HOME: path.join(root, 'xdg-state') },
    platform: 'linux',
    paths: { stateDir: path.join(root, 'state') },
    scope: 'global',
    nodePath: '/home/you/node',
    shimPath: '/home/you/bin/brainatlas',
    now: new Date('2026-01-02T03:04:05.000Z')
  };
  return { root, home, ctx };
}

function realisticConfig() {
  return [
    '# Config values use TOML features accepted by Codex CLI.',
    'model = "example-model" # line-end comment',
    'model_reasoning_effort = "medium"',
    'approval_policy = "on-request"',
    'features = { fast_mode = true, enabled = false }',
    'args = [',
    '  "first",',
    '  "second", # trailing comma is allowed',
    ']',
    'prompt_note = """First line',
    'Second line with # content, not a TOML comment.',
    'Third line."""',
    "literal_note = 'literal # string'",
    '',
    '[projects."/Users/you/proj"]',
    'trust_level = "trusted"',
    'env = { A = "b", nested = { enabled = true } }',
    'project_args = [',
    '  "one",',
    '  "two",',
    ']',
    '',
    '[mcp_servers."sample-server"]',
    'command = "example-command"',
    'env = { MODE = "example", RETRIES = 2 }',
    '',
    '[[array.of.tables]]',
    'name = "first"',
    'values = [1, 2, 3]',
    '',
    '[[array.of.tables]]',
    'name = "second"',
    'values = [',
    '  "alpha",',
    '  "beta",',
    ']',
    '',
    '[array.of.tables.metadata]',
    'source = "synthetic"',
    ...Array.from({ length: 125 }, (_, index) => `# synthetic padding line ${String(index + 1).padStart(3, '0')}`),
    ''
  ].join('\n');
}

test('Codex accepts real-world TOML structures and restores every original byte after removal', async () => {
  const { root, home, ctx } = await setup();
  const config = realisticConfig();
  assert.ok(config.split('\n').length >= 150);
  try {
    const configPath = path.join(home, '.codex', 'config.toml');
    const hooksPath = path.join(home, '.codex', 'hooks.json');
    const hooks = '{\n  "otherSetting": true\n}\n';
    await writeFile(configPath, config);
    await writeFile(hooksPath, hooks);

    const planned = adapter.plan(ctx);
    assert.ok(planned.changes.some(change => change.file === configPath));
    await adapter.apply(planned, ctx);
    const applied = await readFile(configPath, 'utf8');
    assert.ok(applied.startsWith(config));
    assert.match(applied, /^\[mcp_servers\.brainatlas\]$/m);
    assert.match(applied, /^\[projects\."\/Users\/you\/proj"\]$/m);
    assert.match(applied, /^\[mcp_servers\."sample-server"\]$/m);
    assert.equal((applied.match(/^\[\[array\.of\.tables\]\]$/gm) || []).length, 2);

    await adapter.remove(ctx);
    assert.equal(await readFile(configPath, 'utf8'), config);
    assert.equal(await readFile(hooksPath, 'utf8'), hooks);
    await assert.rejects(readFile(path.join(home, '.codex', 'AGENTS.md')), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const [name, invalid] of [
  ['unterminated array', 'args = [\n  "first",\n'],
  ['unterminated string', 'prompt_note = """still open\n'],
  ['duplicate table', '[tool]\nvalue = 1\n[tool]\nother = 2\n'],
  ['invalid quoted header', '[projects."unfinished]\nvalue = 1\n']
]) {
  test(`Codex refuses ${name} without writing any file`, async () => {
    const { root, home, ctx } = await setup();
    try {
      const configPath = path.join(home, '.codex', 'config.toml');
      await writeFile(configPath, invalid);
      const before = await readFile(configPath);
      assert.throws(() => adapter.plan(ctx), { code: 'E_CONFIG_PARSE' });
      assert.deepEqual(await readFile(configPath), before);
      await assert.rejects(readFile(path.join(home, '.codex', 'hooks.json')), { code: 'ENOENT' });
      await assert.rejects(readFile(path.join(home, '.codex', 'AGENTS.md')), { code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test('quoted managed table names keep the canonical unquoted BrainAtlas header and restore original bytes', async () => {
  const { root, home, ctx } = await setup();
  const original = '[mcp_servers."brainatlas"]\ncommand = "user-command"\n';
  try {
    const configPath = path.join(home, '.codex', 'config.toml');
    await writeFile(configPath, original);
    const planned = adapter.plan(ctx);
    await adapter.apply(planned, ctx);
    assert.match(await readFile(configPath, 'utf8'), /^\[mcp_servers\.brainatlas\]$/m);
    await adapter.remove(ctx);
    assert.equal(await readFile(configPath, 'utf8'), original);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
