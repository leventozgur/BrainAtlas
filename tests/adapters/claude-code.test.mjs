// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as adapter from '../../packages/adapters/claude-code/src/index.mjs';

const fixtures = new URL('./claude-code/fixtures/', import.meta.url);
async function setup(name = 'empty') {
  const base = await mkdtemp(join(tmpdir(), 'brainatlas-adapter-'));
  const home = join(base, 'home'); await mkdir(home, { recursive: true });
  if (name === 'existing') {
    await mkdir(join(home, '.claude'), { recursive: true });
    await cp(new URL('existing/.claude.json', fixtures), join(home, '.claude.json'));
    await cp(new URL('existing/settings.json', fixtures), join(home, '.claude', 'settings.json'));
    await cp(new URL('existing/CLAUDE.md', fixtures), join(home, 'CLAUDE.md'));
  }
  const shimPath = join(base, 'Brain Atlas', 'bin', 'brainatlas'); await mkdir(join(base, 'Brain Atlas', 'bin'), { recursive: true }); await writeFile(shimPath, 'fixture shim');
  const ctx = { env: { HOME: home, XDG_STATE_HOME: join(base, 'state') }, platform: 'linux', scope: 'global', nodePath: '/opt/node with spaces/node', shimPath, now: new Date('2026-11-08T10:11:12.000Z') };
  return { base, home, ctx };
}
async function snapshot(root) {
  const files = ['.claude.json', '.claude/settings.json', 'CLAUDE.md']; const result = {};
  for (const file of files) { try { result[file] = await readFile(join(root, file)); } catch (error) { if (error.code !== 'ENOENT') throw error; result[file] = null; } }
  return result;
}

test('detect and contract metadata', () => {
  assert.equal(adapter.detect({ HOME: '/user', CLAUDE_CODE: '1' }), true);
  assert.equal(adapter.detect({ HOME: '/user' }), false);
  assert.equal(adapter.id, 'claude-code');
});

for (const fixture of ['empty', 'existing']) test(`apply then remove restores ${fixture} fixture byte-for-byte`, async () => {
  const { base, home, ctx } = await setup(fixture); const before = await snapshot(home);
  try {
    const planned = adapter.plan(ctx); assert.ok(planned.changes.length > 0); assert.equal(planned.trustReviewRequired, true);
    await adapter.apply(planned, ctx);
    if (fixture === 'existing') {
      const backup = await readFile(join(home, `.claude.json.bak.20261108T101112000Z`));
      assert.deepEqual(backup, before['.claude.json']);
    }
    assert.equal(adapter.plan(ctx).changes.length, 0);
    const mcp = JSON.parse(await readFile(join(home, '.claude.json'), 'utf8'));
    assert.equal(mcp.mcpServers.brainatlas.command, ctx.nodePath);
    assert.deepEqual(mcp.mcpServers.brainatlas.args, [ctx.shimPath, 'mcp']);
    const settings = JSON.parse(await readFile(join(home, '.claude/settings.json'), 'utf8'));
    assert.ok(settings.hooks.UserPromptSubmit.length > 0 && settings.hooks.SessionStart.length > 0);
    for (const [event, expected] of Object.entries({ UserPromptSubmit: 'prompt', SessionStart: 'session-start' })) {
      const command = settings.hooks[event].flatMap(group => group.hooks).find(hook => hook.command.includes(ctx.shimPath)).command;
      const args = command.match(/ hook (\S+) (\S+)$/)?.slice(1);
      assert.deepEqual(args, ['claude', expected]);
      assert.ok(['claude', 'codex', 'kiro', 'copilot', 'gemini'].includes(args[0]));
      assert.ok(['prompt', 'session-start', 'session-end'].includes(args[1]));
    }
    await adapter.remove(ctx);
    const after = await snapshot(home);
    for (const key of Object.keys(before)) assert.deepEqual(after[key], before[key], key);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('vault scope writes project configuration only', async () => {
  const { base, home, ctx } = await setup(); const vault = join(base, 'vault'); await mkdir(vault);
  ctx.scope = 'vault'; ctx.vaultDir = vault;
  try {
    const p = adapter.plan(ctx); assert.ok(p.changes.every(change => change.file.startsWith(vault)));
    await adapter.apply(p, ctx);
    assert.equal(await readFile(join(vault, '.mcp.json'), 'utf8').then(v => JSON.parse(v).mcpServers.brainatlas.command), ctx.nodePath);
    assert.equal((await snapshot(home))['.claude.json'], null);
    await adapter.remove(ctx); assert.deepEqual(await snapshot(vault), { '.claude.json': null, '.claude/settings.json': null, 'CLAUDE.md': null });
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('refuses malformed JSON, BOM, and edited managed block without writing', async () => {
  const { base, home, ctx } = await setup();
  try {
    await cp(new URL('broken/.claude.json', fixtures), join(home, '.claude.json'));
    assert.throws(() => adapter.plan(ctx), error => error.code === 'E_CONFIG_PARSE');
    await writeFile(join(home, '.claude.json'), '{}'); await mkdir(join(home, '.claude'), { recursive: true });
    await cp(new URL('bom/settings.json', fixtures), join(home, '.claude/settings.json'));
    assert.throws(() => adapter.plan(ctx), error => error.code === 'E_BOM');
    await writeFile(join(home, '.claude/settings.json'), '{}');
    await writeFile(join(home, 'CLAUDE.md'), '<!-- brainatlas:begin -->\nuser edit\n<!-- brainatlas:end -->\n');
    assert.throws(() => adapter.plan(ctx), error => error.code === 'E_MANAGED_BLOCK_EDITED');
    assert.equal(await readFile(join(home, '.claude.json'), 'utf8'), '{}');
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('apply rechecks planned bytes and keeps unrelated user settings when removing', async () => {
  const { base, home, ctx } = await setup('existing');
  try {
    const p = adapter.plan(ctx); await writeFile(join(home, '.claude.json'), '{"changed":true}');
    await assert.rejects(adapter.apply(p, ctx), error => error.code === 'E_CONFIG_CHANGED');
    await writeFile(join(home, '.claude.json'), await readFile(new URL('existing/.claude.json', fixtures)));
    await adapter.apply(adapter.plan(ctx), ctx);
    const settingsFile = join(home, '.claude/settings.json');
    const settings = JSON.parse(await readFile(settingsFile, 'utf8')); settings.theme = 'light';
    await writeFile(settingsFile, JSON.stringify(settings, null, 4) + '\n');
    await adapter.remove(ctx);
    const after = JSON.parse(await readFile(settingsFile, 'utf8'));
    assert.equal(after.theme, 'light'); assert.ok(after.hooks.Notification);
    assert.equal(after.hooks.UserPromptSubmit[0].hooks[0].command, 'user-hook');
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('apply rejects a modified plan target outside the adapter scope before writing', async () => {
  const { base, home, ctx } = await setup(); const outside = join(base, 'outside.json');
  await writeFile(outside, '{"keep":true}');
  try {
    const p = adapter.plan(ctx);
    p.changes[0].file = outside;
    await assert.rejects(adapter.apply(p, ctx), error => error.code === 'E_PLAN_TARGET');
    assert.equal(await readFile(outside, 'utf8'), '{"keep":true}');
    assert.deepEqual(await snapshot(home), { '.claude.json': null, '.claude/settings.json': null, 'CLAUDE.md': null });
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('remove preflights all files before removing any when the managed block was edited', async () => {
  const { base, home, ctx } = await setup();
  try {
    await adapter.apply(adapter.plan(ctx), ctx);
    const mcpBefore = await readFile(join(home, '.claude.json'));
    const settingsBefore = await readFile(join(home, '.claude/settings.json'));
    const edited = (await readFile(join(home, 'CLAUDE.md'), 'utf8')).replace('evidence-first', 'edited');
    await writeFile(join(home, 'CLAUDE.md'), edited);
    await assert.rejects(adapter.remove(ctx), error => error.code === 'E_MANAGED_BLOCK_EDITED');
    assert.deepEqual(await readFile(join(home, '.claude.json')), mcpBefore);
    assert.deepEqual(await readFile(join(home, '.claude/settings.json')), settingsBefore);
    assert.equal(await readFile(join(home, 'CLAUDE.md'), 'utf8'), edited);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('vault paths reject parent segments and remove restores empty and pre-existing BrainAtlas data', async () => {
  const { base, home, ctx } = await setup();
  const vault = join(base, 'vault'); await mkdir(vault);
  try {
    ctx.scope = 'vault'; ctx.vaultDir = `${vault}/../vault`;
    assert.throws(() => adapter.plan(ctx), error => error.code === 'E_PATH_ESCAPE');

    ctx.scope = 'global';
    await writeFile(join(home, 'CLAUDE.md'), '');
    const entry = { type: 'stdio', command: ctx.nodePath, args: [ctx.shimPath, 'mcp'], env: {} };
    await writeFile(join(home, '.claude.json'), JSON.stringify({ mcpServers: { brainatlas: entry } }, null, 2));
    const beforeMcp = await readFile(join(home, '.claude.json'));
    await adapter.apply(adapter.plan(ctx), ctx);
    await adapter.remove(ctx);
    assert.deepEqual(await readFile(join(home, '.claude.json')), beforeMcp);
    assert.equal(await readFile(join(home, 'CLAUDE.md'), 'utf8'), '');
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('doctor and trust review report Claude Code setup', async () => {
  const { base, ctx } = await setup();
  try {
    await adapter.apply(adapter.plan(ctx), ctx);
    const result = await adapter.doctor(ctx);
    assert.equal(result.ok, true); assert.deepEqual(result.checks.map(check => check.id), ['registered', 'shim', 'version-drift', 'hook-present']);
    assert.deepEqual(await adapter.trustReview(ctx), { required: true, client: 'Claude Code', steps: ['Start a new Claude Code session.', 'Approve the BrainAtlas MCP server if prompted.'] });
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('upgrade replaces legacy hooks, preserves user hooks, and uninstall removes both formats', async () => {
  const { base, home, ctx } = await setup('existing');
  const file = join(home, '.claude/settings.json');
  try {
    const settings = JSON.parse(await readFile(file, 'utf8'));
    const legacy = event => `"${ctx.nodePath}" "${ctx.shimPath}" hook claude-code ${event}`;
    settings.hooks.UserPromptSubmit[0].hooks.push({ type: 'command', command: legacy('UserPromptSubmit'), timeout: 5 });
    settings.hooks.SessionStart = [{ hooks: [{ type: 'command', command: legacy('SessionStart') }] }];
    await writeFile(file, JSON.stringify(settings, null, 2));
    assert.equal((await adapter.doctor(ctx)).checks.find(check => check.id === 'hook-present').ok, false);
    await adapter.apply(adapter.plan(ctx), ctx);
    const upgraded = JSON.parse(await readFile(file, 'utf8'));
    for (const [event, expected] of Object.entries({ UserPromptSubmit: 'prompt', SessionStart: 'session-start' })) {
      const commands = upgraded.hooks[event].flatMap(group => group.hooks).map(hook => hook.command);
      assert.equal(commands.filter(command => command.includes(ctx.shimPath)).length, 1);
      assert.ok(commands.includes(`"${ctx.nodePath}" "${ctx.shimPath}" hook claude ${expected}`));
    }
    assert.equal(upgraded.hooks.UserPromptSubmit[0].hooks[0].command, 'user-hook');
    assert.equal((await adapter.doctor(ctx)).checks.find(check => check.id === 'hook-present').ok, true);
    const beforeSecondInstall = await readFile(file);
    const secondPlan = adapter.plan(ctx); assert.equal(secondPlan.changes.length, 0);
    await adapter.apply(secondPlan, ctx);
    assert.deepEqual(await readFile(file), beforeSecondInstall);
    // Simulate an old hook reappearing alongside the installed hook.
    upgraded.hooks.SessionStart[0].hooks.push({ type: 'command', command: legacy('SessionStart') });
    await writeFile(file, JSON.stringify(upgraded));
    await adapter.remove(ctx);
    const removed = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(removed.hooks.UserPromptSubmit[0].hooks[0].command, 'user-hook');
    assert.ok(!JSON.stringify(removed).includes(ctx.shimPath));
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('uninstall does not restore legacy hooks from the original settings snapshot', async () => {
  const { base, home, ctx } = await setup('existing');
  const file = join(home, '.claude/settings.json');
  try {
    const settings = JSON.parse(await readFile(file, 'utf8'));
    settings.hooks.UserPromptSubmit[0].hooks.push({ type: 'command', command: `"${ctx.nodePath}" "${ctx.shimPath}" hook claude-code UserPromptSubmit` });
    await writeFile(file, JSON.stringify(settings));
    await adapter.apply(adapter.plan(ctx), ctx);
    await adapter.remove(ctx);
    const removed = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(removed.hooks.UserPromptSubmit[0].hooks[0].command, 'user-hook');
    assert.ok(!JSON.stringify(removed).includes(ctx.shimPath));
  } finally { await rm(base, { recursive: true, force: true }); }
});
