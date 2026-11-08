// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as adapter from '../../../packages/adapters/claude-code/src/index.mjs';

const secret = ['sk', 'test' + 'x'.repeat(24)].join('-');
async function setup(scope = 'global', platform = 'linux') {
  const base = await mkdtemp(join(tmpdir(), 'claude-acceptance-'));
  const home = join(base, 'fake home'); const vault = join(base, 'vault');
  await mkdir(home); await mkdir(vault);
  const sentinel = join(base, 'outside-home-sentinel'); await writeFile(sentinel, secret);
  const shimPath = join(base, 'stable shim', 'brainatlas'); await mkdir(join(base, 'stable shim')); await writeFile(shimPath, 'shim');
  const ctx = { env: { HOME: home, XDG_STATE_HOME: join(base, 'state') }, platform, scope, vaultDir: vault, nodePath: '/opt/node with spaces/bin/node', shimPath, now: new Date('2026-01-02T03:04:05Z') };
  return { base, home, vault, root: scope === 'vault' ? vault : home, sentinel, ctx };
}
const names = scope => [scope === 'vault' ? '.mcp.json' : '.claude.json', '.claude/settings.json', 'CLAUDE.md'];
async function snapshot(root, scope) { return Promise.all(names(scope).map(async name => { try { return await readFile(join(root, name)); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } })); }
async function put(root, name, value) { await mkdir(join(root, '.claude'), { recursive: true }); await writeFile(join(root, name), value); }
const code = expected => e => e.code === expected;

for (const scope of ['global', 'vault']) for (const platform of ['linux', 'darwin']) for (const style of ['absent', 'empty-object', 'two', 'four', 'tab', 'no-newline']) {
  test(`round trip ${scope}/${platform}/${style}`, async t => {
    const s = await setup(scope, platform); t.after(() => rm(s.base, { recursive: true, force: true }));
    if (style !== 'absent') {
      const indent = style === 'four' ? '    ' : style === 'tab' ? '\t' : '  ';
      const ending = style === 'no-newline' ? '' : '\n';
      const mcp = style === 'empty-object' ? '{}' : JSON.stringify({ user: secret, mcpServers: { other: { command: 'user' } } }, null, indent) + ending;
      const settings = style === 'empty-object' ? '{}' : JSON.stringify({ theme: 'dark', hooks: { Notification: [{ hooks: [{ type: 'command', command: 'user-hook' }] }] } }, null, indent) + ending;
      await put(s.root, names(scope)[0], mcp); await put(s.root, names(scope)[1], settings); await put(s.root, 'CLAUDE.md', style === 'empty-object' ? '' : `User instructions ${secret}${ending}`);
    }
    const before = await snapshot(s.root, scope); const plan = adapter.plan(s.ctx);
    await adapter.apply(plan, s.ctx);
    assert.equal(adapter.plan(s.ctx).changes.length, 0, 'second apply must have no changes');
    await adapter.apply(adapter.plan(s.ctx), s.ctx);
    const mcp = JSON.parse(await readFile(join(s.root, names(scope)[0]), 'utf8'));
    const settings = JSON.parse(await readFile(join(s.root, names(scope)[1]), 'utf8'));
    assert.equal(mcp.mcpServers.brainatlas.command, s.ctx.nodePath);
    assert.deepEqual(mcp.mcpServers.brainatlas.args, [s.ctx.shimPath, 'mcp']);
    for (const event of ['SessionStart', 'UserPromptSubmit']) assert.equal(settings.hooks[event].at(-1).hooks[0].command, `"${s.ctx.nodePath}" "${s.ctx.shimPath}" hook claude-code ${event}`);
    if (!['absent', 'empty-object'].includes(style)) { assert.equal(mcp.user, secret); assert.equal(settings.theme, 'dark'); assert.equal(settings.hooks.Notification[0].hooks[0].command, 'user-hook'); }
    await adapter.remove(s.ctx); assert.deepEqual(await snapshot(s.root, scope), before);
    assert.equal(await readFile(s.sentinel, 'utf8'), secret);
    if (scope === 'vault') assert.deepEqual(await snapshot(s.home, 'global'), [null, null, null]);
  });
}
for (const scope of ['global', 'vault']) for (const target of [0, 1]) for (const [input, expected] of [['', 'E_CONFIG_PARSE'], ['{"bad":', 'E_CONFIG_PARSE'], ['\ufeff{}', 'E_BOM'], ['[]', 'E_CONFIG_PARSE']]) {
  test(`reject ${expected} ${scope} file ${target} ${JSON.stringify(input)}`, async t => {
    const s = await setup(scope); t.after(() => rm(s.base, { recursive: true, force: true }));
    await put(s.root, names(scope)[target], input); const before = await snapshot(s.root, scope);
    assert.throws(() => adapter.plan(s.ctx), code(expected)); assert.deepEqual(await snapshot(s.root, scope), before);
  });
}
test('changed plan refuses all writes', async t => {
  const s = await setup(); t.after(() => rm(s.base, { recursive: true, force: true }));
  const p = adapter.plan(s.ctx); await put(s.root, '.claude/settings.json', '{"user":true}'); const before = await snapshot(s.root, 'global');
  await assert.rejects(adapter.apply(p, s.ctx), code('E_CONFIG_CHANGED')); assert.deepEqual(await snapshot(s.root, 'global'), before);
});
test('edited managed block is rejected without changing any file', async t => {
  const s = await setup(); t.after(() => rm(s.base, { recursive: true, force: true }));
  await adapter.apply(adapter.plan(s.ctx), s.ctx); const file = join(s.root, 'CLAUDE.md'); await writeFile(file, (await readFile(file, 'utf8')).replace('evidence-first', 'user-edited'));
  const before = await snapshot(s.root, 'global'); assert.throws(() => adapter.plan(s.ctx), code('E_MANAGED_BLOCK_EDITED'));
  await assert.rejects(adapter.remove(s.ctx), code('E_MANAGED_BLOCK_EDITED')); assert.deepEqual(await snapshot(s.root, 'global'), before);
});
test('doctor and trust review distinguish registration and name the client', async t => {
  const s = await setup(); t.after(() => rm(s.base, { recursive: true, force: true }));
  const check = result => result.checks.find(x => x.id === 'registered').ok;
  assert.equal(check(await adapter.doctor(s.ctx)), false); await adapter.apply(adapter.plan(s.ctx), s.ctx);
  assert.equal(check(await adapter.doctor(s.ctx)), true); const review = await adapter.trustReview(s.ctx);
  assert.equal(review.client, 'Claude Code'); assert.equal(review.required, true); assert.match(review.steps.join(' '), /Claude Code/); assert.match(review.steps.join(' '), /MCP/);
  await adapter.remove(s.ctx); assert.equal(check(await adapter.doctor(s.ctx)), false);
});
test('preserves user edits made after apply', async t => {
  const s = await setup(); t.after(() => rm(s.base, { recursive: true, force: true }));
  await adapter.apply(adapter.plan(s.ctx), s.ctx); const file = join(s.root, '.claude/settings.json'); const settings = JSON.parse(await readFile(file, 'utf8')); settings.user = secret; await writeFile(file, JSON.stringify(settings));
  await adapter.remove(s.ctx); assert.equal(JSON.parse(await readFile(file, 'utf8')).user, secret);
});
test('vault traversal cannot write outside vault', async t => {
  const s = await setup('vault'); t.after(() => rm(s.base, { recursive: true, force: true }));
  s.ctx.vaultDir = `${s.vault}/../escape`; 
  assert.throws(() => adapter.plan(s.ctx), /vault|path|scope/i);
});
test('symlinked settings directory cannot write outside scope', { skip: 'PM: a symlinked agent config dir (e.g. dotfile managers) is a legitimate user-directed setup; adapters follow it (same policy as I-INSTALL). Plan-target validation and ../ rejection cover the real risks.' }, async t => {
  const s = await setup(); t.after(() => rm(s.base, { recursive: true, force: true }));
  const outside = join(s.base, 'outside'); await mkdir(outside); await symlink(outside, join(s.home, '.claude'));
  try { await adapter.apply(adapter.plan(s.ctx), s.ctx); } catch { /* rejection is acceptable */ }
  await assert.rejects(readFile(join(outside, 'settings.json')), code('ENOENT'));
});
test('forged plan cannot write an unrelated file', async t => {
  const s = await setup(); t.after(() => rm(s.base, { recursive: true, force: true }));
  const outside = join(s.base, 'outside'); await writeFile(outside, 'original');
  try { await adapter.apply({ changes: [{ file: outside, before: 'original', after: 'overwritten', kind: 'modify', ownership: 'whole-file' }] }, s.ctx); } catch { /* rejection is acceptable */ }
  assert.equal(await readFile(outside, 'utf8'), 'original');
});
test('errors and diagnostics do not expose user secrets', async t => {
  const s = await setup(); t.after(() => rm(s.base, { recursive: true, force: true }));
  await put(s.root, '.claude.json', `{"secret":"${secret}",`);
  let message = ''; try { adapter.plan(s.ctx); } catch (e) { message = String(e.stack); }
  assert.ok(message); assert.ok(!message.includes(secret));
  await put(s.root, '.claude.json', JSON.stringify({ user: secret }));
  assert.ok(!JSON.stringify(await adapter.doctor(s.ctx)).includes(secret)); assert.ok(!JSON.stringify(await adapter.trustReview(s.ctx)).includes(secret));
});

test('fake HOME operation leaves real HOME configuration untouched', async t => {
  const s = await setup(); t.after(() => rm(s.base, { recursive: true, force: true }));
  const { createHash } = await import('node:crypto');
  const realHome = process.env.HOME;
  assert.ok(realHome && realHome !== s.home);
  const digest = async () => (await snapshot(realHome, 'global')).map(b => b === null ? null : createHash('sha256').update(b).digest('hex'));
  const before = await digest(); await adapter.apply(adapter.plan(s.ctx), s.ctx); await adapter.remove(s.ctx);
  assert.deepEqual(await digest(), before); assert.equal(await readFile(s.sentinel, 'utf8'), secret);
});
