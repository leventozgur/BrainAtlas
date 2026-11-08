// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, readFile, rm, mkdir, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as adapter from '../../packages/adapters/copilot-vscode/src/index.mjs';

const FIXTURES = resolve('tests/adapters/copilot-vscode/fixtures');
const ctxFor = (HOME, extra = {}) => ({
  env: { HOME, BRAINATLAS_PLATFORM: 'linux' }, platform: 'linux', scope: 'global',
  config: { vault: { path: join(HOME, 'vault') }, agents: { copilot: {} } },
  paths: { stateDir: join(HOME, '.state'), vault: join(HOME, 'vault') },
  nodePath: '/usr/bin/node', shimPath: '/opt/brainatlas/bin/brainatlas', now: new Date('2026-11-08T12:00:00.000Z'), ...extra
});
async function temp(t) { const dir = await mkdtemp(join(tmpdir(), 'copilot-adapter-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }
async function seed(t, name) { const root = await temp(t); const home = join(root, 'home'); await mkdir(home, { recursive: true }); await cp(join(FIXTURES, name), home, { recursive: true }); return home; }
async function exists(path) { try { await access(path); return true; } catch { return false; } }

test('detect uses injected HOME and Copilot configuration directory', async t => {
  const home = await temp(t);
  assert.equal(adapter.detect({ HOME: home }), false);
  await mkdir(join(home, '.copilot'));
  assert.equal(adapter.detect({ HOME: home }), true);
  assert.equal(adapter.detect({}), false);
});

for (const fixture of ['empty', 'existing']) {
  test(`global ${fixture} fixture applies idempotently and removes byte-identically`, async t => {
    const home = await seed(t, fixture); const ctx = ctxFor(home);
    const mcp = join(home, '.copilot', 'mcp-config.json');
    const before = await exists(mcp) ? await readFile(mcp) : null;
    const planned = adapter.plan(ctx);
    assert.ok(planned.changes.length > 0);
    assert.deepEqual((await readFile(mcp).catch(() => null)), before);
    await adapter.apply(planned, ctx);
    assert.deepEqual(adapter.plan(ctx).changes, []);
    const content = JSON.parse(await readFile(mcp, 'utf8'));
    assert.equal(content.mcpServers.brainatlas.command, ctx.nodePath);
    assert.deepEqual(content.mcpServers.brainatlas.args, [ctx.shimPath, 'mcp']);
    if (fixture === 'existing') {
      assert.equal(content.telemetry, false);
      assert.deepEqual(content.custom, [1, 2]);
      assert.equal(content.mcpServers.other.command, 'tool');
    }
    await adapter.remove({ ...ctx, now: new Date('2026-11-08T12:00:01.000Z') });
    if (before === null) assert.equal(await exists(mcp), false);
    else assert.deepEqual(await readFile(mcp), before);
    assert.equal(await exists(join(home, '.copilot', 'hooks', 'brainatlas.json')), false);
  });
}

for (const fixture of ['broken', 'bom']) {
  test(`${fixture} JSON is refused without changing any file`, async t => {
    const home = await seed(t, fixture); const mcp = join(home, '.copilot', 'mcp-config.json');
    const before = await readFile(mcp);
    assert.throws(() => adapter.plan(ctxFor(home)), error => error.code === (fixture === 'bom' ? 'E_BOM' : 'E_CONFIG_PARSE'));
    assert.deepEqual(await readFile(mcp), before);
    assert.equal(await exists(join(home, '.copilot', 'hooks', 'brainatlas.json')), false);
  });
}

test('vault scope uses project files and preserves the original instructions bytes', async t => {
  const home = await temp(t); const vault = join(home, 'project'); await mkdir(join(vault, '.github'), { recursive: true });
  const instructions = join(vault, '.github', 'copilot-instructions.md');
  const source = Buffer.from('# Project rules\r\n\r\nKeep formatting.\r\n'); await writeFile(instructions, source);
  const ctx = ctxFor(join(home, 'user-home'), { scope: 'vault', vaultDir: vault, paths: { stateDir: join(home, '.state'), vault } });
  await adapter.apply(adapter.plan(ctx), ctx);
  const edited = await readFile(instructions, 'utf8');
  assert.match(edited, /brainatlas:sha256:/);
  assert.equal(JSON.parse(await readFile(join(vault, '.vscode', 'mcp.json'), 'utf8')).servers.brainatlas.command, ctx.nodePath);
  await adapter.remove({ ...ctx, now: new Date('2026-11-08T12:00:02.000Z') });
  assert.deepEqual(await readFile(instructions), source);
  assert.equal(await exists(join(vault, '.vscode', 'mcp.json')), false);
});

test('edited managed block and stale plans are refused', async t => {
  const home = await seed(t, 'empty'); const ctx = ctxFor(home); const planned = adapter.plan(ctx);
  await adapter.apply(planned, ctx);
  const instructions = join(home, '.copilot', 'instructions', 'brainatlas.instructions.md');
  await writeFile(instructions, (await readFile(instructions, 'utf8')).replace('Use the BrainAtlas MCP tools', 'Changed user text'));
  await assert.rejects(adapter.remove({ ...ctx, now: new Date('2026-11-08T12:00:03.000Z') }), { code: 'E_CONFIG_OWNERSHIP' });
  const cleanHome = await seed(t, 'empty'); const clean = ctxFor(cleanHome); const stalePlan = adapter.plan(clean);
  await adapter.apply(adapter.plan(clean), clean);
  await writeFile(join(cleanHome, '.copilot', 'mcp-config.json'), '{}\n');
  await assert.rejects(adapter.apply(stalePlan, clean), { code: 'E_CONFIG_CHANGED' });
});

test('vault managed block hash detects user edits', async t => {
  const root = await temp(t); const vault = join(root, 'project'); const home = join(root, 'home');
  await mkdir(join(vault, '.github'), { recursive: true }); await mkdir(home, { recursive: true });
  const ctx = ctxFor(home, { scope: 'vault', vaultDir: vault, paths: { stateDir: join(root, 'state'), vault } });
  await adapter.apply(adapter.plan(ctx), ctx);
  const file = join(vault, '.github', 'copilot-instructions.md');
  await writeFile(file, (await readFile(file, 'utf8')).replace('Use the BrainAtlas MCP tools', 'User changed this block'));
  await assert.rejects(adapter.remove({ ...ctx, now: new Date('2026-11-08T12:00:04.000Z') }), { code: 'E_MANAGED_BLOCK_EDITED' });
});

test('optional VS Code profile MCP and adapter health/trust reporting', async t => {
  const home = await seed(t, 'empty'); const ctx = ctxFor(home, { config: { agents: { copilot: { vscodeUserMcp: true } } } });
  await adapter.apply(adapter.plan(ctx), ctx);
  const profile = JSON.parse(await readFile(join(home, '.config', 'Code', 'User', 'mcp.json'), 'utf8'));
  assert.equal(profile.servers.brainatlas.type, 'stdio');
  const health = await adapter.doctor(ctx);
  assert.equal(health.ok, true);
  assert.ok(health.checks.some(check => check.id === 'policy'));
  assert.deepEqual(await adapter.trustReview(ctx), {
    required: true, client: 'GitHub Copilot for VS Code',
    steps: ['Trust the workspace to allow workspace hooks.', 'Reload the VS Code window or start a new chat session.', 'Confirm the BrainAtlas MCP server starts.']
  });
});
