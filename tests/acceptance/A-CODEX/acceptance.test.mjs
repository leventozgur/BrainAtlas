import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as adapter from '../../../packages/adapters/codex/src/index.mjs';

async function fixture(t, scope = 'global', platform = 'linux') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-accept-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'), vault = path.join(root, 'vault');
  await mkdir(home); await mkdir(vault);
  const sentinel = path.join(root, 'outside-sentinel'); await writeFile(sentinel, 'untouched');
  const ctx = { env: { HOME: home, BRAINATLAS_PLATFORM: platform }, paths: { stateDir: path.join(root, 'state') }, scope, vaultDir: vault, nodePath: '/runtime with spaces/node', shimPath: '/stable shim/brainatlas', now: new Date('2025-01-02T03:04:05Z') };
  const dir = scope === 'vault' ? path.join(vault, '.codex') : path.join(home, '.codex');
  return { root, home, vault, sentinel, ctx, toml: path.join(dir, 'config.toml'), hooks: path.join(dir, 'hooks.json'), md: scope === 'vault' ? path.join(vault, 'AGENTS.md') : path.join(dir, 'AGENTS.md') };
}
async function put(file, value) { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, value); }
async function get(file) { try { return await readFile(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
const code = expected => e => { assert.equal(e.code, expected); return true; };

for (const platform of ['linux', 'darwin']) for (const scope of ['global', 'vault']) {
  test(`${platform} ${scope}: absent files restore, repeat apply is idempotent, doctor and instructions`, async t => {
    const f = await fixture(t, scope, platform);
    assert.equal((await adapter.doctor(f.ctx)).checks.find(x => x.id === 'registered').ok, false);
    const p = adapter.plan(f.ctx); assert.ok(p.changes.length >= 2);
    await adapter.apply(p, f.ctx);
    assert.equal(adapter.plan(f.ctx).changes.length, 0);
    assert.equal((await adapter.doctor(f.ctx)).checks.find(x => x.id === 'registered').ok, true);
    assert.match(await get(f.md), /pull mode.*wiki_query/);
    const config = await get(f.toml); assert.match(config, /\/runtime with spaces\/node/); assert.match(config, /\/stable shim\/brainatlas/);
    if (scope === 'global') { const hook = JSON.parse(await get(f.hooks)); assert.match(hook.hooks.UserPromptSubmit[0].hooks[0].command, /^"\/runtime with spaces\/node" "\/stable shim\/brainatlas"/); }
    await adapter.remove(f.ctx);
    assert.equal(await get(f.toml), null); assert.equal(await get(f.md), null); assert.equal(await get(f.hooks), null);
    assert.equal(await get(f.sentinel), 'untouched');
  });
}
for (const [name, toml, hooks, md] of [
  ['two spaces newline', 'model = "example"\n', '{\n  "user": true\n}\n', '# User\n'],
  ['four spaces no newline', 'model = "example"', '{\n    "user": true\n}', '# User'],
  ['tab newline', 'model = "example"\n', '{\n\t"user": true\n}\n', '# User\n'],
  ['empty existing files', '', '', ''],
  ['existing brainatlas entry', '[mcp_servers.brainatlas]\ncommand = "old"\nargs = ["old"]\n', '{"mcpServers":{"brainatlas":{"command":"old"}}}', '# User\n']
]) test(`byte restoration: ${name}`, async t => {
  const f = await fixture(t); await put(f.toml, toml); await put(f.hooks, hooks); await put(f.md, md);
  await adapter.apply(adapter.plan(f.ctx), f.ctx); await adapter.remove(f.ctx);
  assert.equal(await get(f.toml), toml); assert.equal(await get(f.hooks), hooks); assert.equal(await get(f.md), md);
});
for (const [file, contents, expected] of [ ['toml', 'bad line', 'E_CONFIG_PARSE'], ['hooks', '{bad', 'E_CONFIG_PARSE'], ['toml', '\ufeffmodel = "x"', 'E_BOM'], ['hooks', '\ufeff{}', 'E_BOM'], ['md', '\ufeff# heading', 'E_BOM'] ]) {
  test(`${file} rejects malformed/BOM bytes without changes`, async t => {
    const f = await fixture(t); await put(f[file], contents);
    assert.throws(() => adapter.plan(f.ctx), code(expected)); assert.equal(await get(f[file]), contents);
    assert.equal(await get(f.sentinel), 'untouched');
  });
}
test('changed plan rejects without modifying earlier targets', async t => {
  const f = await fixture(t); const p = adapter.plan(f.ctx); await put(f.md, 'external edit');
  await assert.rejects(adapter.apply(p, f.ctx), code('E_CONFIG_CHANGED'));
  assert.equal(await get(f.toml), null); assert.equal(await get(f.hooks), null); assert.equal(await get(f.md), 'external edit');
});
test('forged target rejected before any write', async t => {
  const f = await fixture(t); const p = adapter.plan(f.ctx);
  p.changes.push({ file: f.sentinel, before: 'untouched', after: 'overwritten', kind: 'modify', ownership: 'whole-file' });
  await assert.rejects(adapter.apply(p, f.ctx), code('E_PLAN_TARGET'));
  assert.equal(await get(f.sentinel), 'untouched'); assert.equal(await get(f.toml), null);
});
test('edited managed block rejects remove atomically', async t => {
  const f = await fixture(t); await put(f.toml, 'model = "x"\n'); await put(f.md, '# notes\n');
  await adapter.apply(adapter.plan(f.ctx), f.ctx);
  const beforeToml = await get(f.toml), beforeHooks = await get(f.hooks);
  const edited = (await get(f.md)).replace('Before acting', 'After acting'); await put(f.md, edited);
  await assert.rejects(adapter.remove(f.ctx), code('E_MANAGED_BLOCK_EDITED'));
  assert.equal(await get(f.toml), beforeToml); assert.equal(await get(f.hooks), beforeHooks); assert.equal(await get(f.md), edited);
});
for (const bad of ['relative/vault', '/tmp/../escape']) test(`vault path rejects ${bad}`, async t => {
  const f = await fixture(t, 'vault'); f.ctx.vaultDir = bad;
  assert.throws(() => adapter.plan(f.ctx), code('E_PATH_ESCAPE')); assert.equal(await get(f.sentinel), 'untouched');
});
test('trust review identifies Codex and supplies steps; detect handles absent home', async t => {
  const f = await fixture(t); const review = await adapter.trustReview(f.ctx);
  assert.match(review.client, /codex/i); assert.ok(review.steps.length); assert.match(review.steps.join(' '), /codex/i);
  assert.equal(adapter.detect({ HOME: f.home }), true); assert.equal(adapter.detect({}), false);
});
test('unrelated edits survive removal', async t => {
  const f = await fixture(t); await put(f.toml, 'model = "one"\n'); await put(f.hooks, '{"user":true}\n');
  await adapter.apply(adapter.plan(f.ctx), f.ctx);
  await put(f.toml, (await get(f.toml)).replace('"one"', '"two"'));
  const hooks = JSON.parse(await get(f.hooks)); hooks.user = 'changed'; await put(f.hooks, JSON.stringify(hooks));
  await adapter.remove(f.ctx); assert.match(await get(f.toml), /model = "two"/); assert.equal(JSON.parse(await get(f.hooks)).user, 'changed');
});
test('symlinked target file cannot redirect writes outside scope', async t => {
  const f = await fixture(t); await writeFile(f.sentinel, 'model = \"outside\"\n'); await mkdir(path.dirname(f.toml), { recursive: true }); await symlink(f.sentinel, f.toml);
  try { await adapter.apply(adapter.plan(f.ctx), f.ctx); } catch {}
  assert.equal(await get(f.sentinel), 'model = \"outside\"\n');
});
test('synthetic secret does not appear in errors or review', async t => {
  const f = await fixture(t); const secret = ['sk', 'test' + 'x'.repeat(24)].join('-'); await put(f.hooks, `{${secret}`);
  let output = ''; try { adapter.plan(f.ctx); } catch (e) { output = `${e.message} ${e.stack}`; }
  output += JSON.stringify(await adapter.trustReview(f.ctx)); assert.ok(!output.includes(secret));
});

test('edited newly created managed instructions are not deleted', async t => {
  const f = await fixture(t); await adapter.apply(adapter.plan(f.ctx), f.ctx);
  const edited = (await get(f.md)).replace('Before acting', 'After acting'); await put(f.md, edited);
  await assert.rejects(adapter.remove(f.ctx), code('E_MANAGED_BLOCK_EDITED'));
  assert.equal(await get(f.md), edited);
});
