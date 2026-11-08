// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, readdir } from 'node:fs/promises';
import * as adapter from '../../../packages/adapters/codex/src/index.mjs';

async function fixture(t, config = '') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-blind-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'), dir = path.join(home, '.codex');
  await mkdir(dir, { recursive: true });
  const toml = path.join(dir, 'config.toml'), hooks = path.join(dir, 'hooks.json');
  await writeFile(toml, config);
  const ctx = { env: { HOME: home }, platform: 'linux', paths: { stateDir: path.join(root, 'state') }, scope: 'global', nodePath: '/usr/bin/node', shimPath: '/opt/example/brainatlas', now: new Date('2026-01-02T00:00:00Z') };
  return { root, home, dir, toml, hooks, ctx };
}
const code = value => error => error.code === value;
function realistic() {
  const lines = ['model = "example" # inline comment', 'features = { enabled = true, label = "a#b" }', 'args = [', '  "one", # comment', '  "two",', ']', 'instructions = """', 'line one', 'line two with [brackets] and # text', '"""', '[projects."/workspace/sample/project"]', 'trust_level = "trusted"', '[mcp_servers."example-server"]', 'command = "example"', 'env = { A = "b", NESTED = { value = "c" } }', '[[tools.examples]]', 'name = "first"', '[[tools.examples]]', 'name = "second"'];
  for (let i = 0; i < 43; i++) lines.push(`[projects."/workspace/project-${i}"]`, `trust_level = "trusted" # ${i}`, `note = "item ${i}"`);
  return lines.join('\r\n') + '\r\n';
}
test('realistic 148-line TOML and existing hooks survive plan/apply/remove byte for byte', async t => {
  const original = realistic(), f = await fixture(t, original);
  const hookBytes = '{\n  "hooks": {"SessionStart": [{"hooks": [{"type": "command", "command": "existing"}]}]},\n  "other": true\n}\n';
  await writeFile(f.hooks, hookBytes);
  const p = adapter.plan(f.ctx), change = p.changes.find(c => c.file === f.toml);
  assert.equal(change.before, original);
  assert.ok(change.after.startsWith(original));
  assert.match(change.after, /\[mcp_servers\.brainatlas\]/);
  await adapter.apply(p, f.ctx);
  assert.equal(await readFile(f.toml, 'utf8'), change.after);
  const hooks = JSON.parse(await readFile(f.hooks, 'utf8'));
  assert.equal(hooks.hooks.SessionStart[0].hooks[0].command, 'existing');
  assert.equal(hooks.hooks.UserPromptSubmit.length, 1);
  assert.equal(adapter.plan(f.ctx).changes.length, 0);
  await adapter.remove(f.ctx);
  assert.equal(await readFile(f.toml, 'utf8'), original);
  assert.equal(await readFile(f.hooks, 'utf8'), hookBytes);
});
for (const [name, text] of [
  ['open array', 'args = [\n "a",\n'], ['open single-line string', 'x = "unfinished\n'],
  ['open multiline string', 'x = """unfinished\n'], ['duplicate table', '[a.b]\nx = 1\n[a.b]\ny = 2\n'],
  ['duplicate quoted table', '[a."b"]\nx = 1\n[a.b]\ny = 2\n'], ['bad header', '[a..b]\nx = 1\n'],
  ['missing header bracket', '[a.b\nx = 1\n']
]) test(`reject ${name} before writing any target`, async t => {
  const f = await fixture(t, text), before = await readdir(f.dir);
  assert.throws(() => adapter.plan(f.ctx), code('E_CONFIG_PARSE'));
  assert.equal(await readFile(f.toml, 'utf8'), text);
  assert.deepEqual(await readdir(f.dir), before);
});
test('invalid hooks and stale TOML refuse the whole apply', async t => {
  const f = await fixture(t, 'value = 1\n');
  await writeFile(f.hooks, '{ broken');
  assert.throws(() => adapter.plan(f.ctx), code('E_CONFIG_PARSE'));
  assert.equal(await readFile(f.toml, 'utf8'), 'value = 1\n');
  await writeFile(f.hooks, '{}\n');
  const p = adapter.plan(f.ctx);
  await writeFile(f.toml, 'value = [\n');
  await assert.rejects(adapter.apply(p, f.ctx), code('E_CONFIG_PARSE'));
  assert.equal(await readFile(f.hooks, 'utf8'), '{}\n');
});
test('quoted existing managed-name table follows ordinary collision lifecycle', async t => {
  const original = '[mcp_servers."brainatlas"]\ncommand = "existing"\nargs = ["original"]\n[other]\nx = 1\n';
  const f = await fixture(t, original), p = adapter.plan(f.ctx);
  await adapter.apply(p, f.ctx);
  assert.match(await readFile(f.toml, 'utf8'), /\[mcp_servers\.brainatlas\]/);
  await adapter.remove(f.ctx);
  assert.equal(await readFile(f.toml, 'utf8'), original);
});
test('managed-marker text inside a multiline string is user data', async t => {
  const original = 'prompt = """\n# brainatlas:begin\nexample text\n# brainatlas:end\n"""\n';
  const f = await fixture(t, original), p = adapter.plan(f.ctx);
  await adapter.apply(p, f.ctx);
  assert.ok((await readFile(f.toml, 'utf8')).startsWith(original));
  await adapter.remove(f.ctx);
  assert.equal(await readFile(f.toml, 'utf8'), original);
});
test('forged plan target and parent traversal are rejected', async t => {
  const f = await fixture(t, 'x = 1\n'), p = adapter.plan(f.ctx), outside = path.join(f.root, 'outside');
  await writeFile(outside, 'sentinel');
  p.changes.push({ file: outside, before: 'sentinel', after: 'changed' });
  await assert.rejects(adapter.apply(p, f.ctx), code('E_PLAN_TARGET'));
  assert.equal(await readFile(outside, 'utf8'), 'sentinel');
  assert.throws(() => adapter.plan({ ...f.ctx, scope: 'vault', vaultDir: path.join(f.root, 'vault') + '/../escape' }), code('E_PATH_ESCAPE'));
});
test('symlinked target does not modify outside file', async t => {
  const f = await fixture(t), outside = path.join(f.root, 'outside');
  await writeFile(outside, 'x = 1\n');
  await rm(f.toml); await symlink(outside, f.toml);
  try { await adapter.apply(adapter.plan(f.ctx), f.ctx); } catch { /* refusal is safe */ }
  assert.equal(await readFile(outside, 'utf8'), 'x = 1\n');
});
test('malformed input errors and doctor do not disclose synthetic secret', async t => {
  const secret = ['sk', 'test' + 'x'.repeat(24)].join('-');
  const f = await fixture(t, `secret = "${secret}"\nbroken = [\n`);
  let error;
  try { adapter.plan(f.ctx); } catch (e) { error = e; }
  assert.equal(error?.code, 'E_CONFIG_PARSE');
  assert.ok(!String(error.stack).includes(secret));
  assert.ok(!JSON.stringify(await adapter.doctor(f.ctx)).includes(secret));
});
test('invalid calendar date is rejected before any write', async t => {
  const f = await fixture(t, 'created = 2026-99-99\n');
  assert.throws(() => adapter.plan(f.ctx), code('E_CONFIG_PARSE'));
  assert.deepEqual(await readdir(f.dir), ['config.toml']);
});
test('symlinked config directory cannot redirect adapter writes outside home', async t => {
  const f = await fixture(t), outside = path.join(f.root, 'outside-dir');
  await rm(f.dir, { recursive: true }); await mkdir(outside);
  await writeFile(path.join(outside, 'config.toml'), 'x = 1\n');
  await symlink(outside, f.dir, 'dir');
  try { await adapter.apply(adapter.plan(f.ctx), f.ctx); } catch { /* refusal is safe */ }
  assert.deepEqual(await readdir(outside), ['config.toml']);
  assert.equal(await readFile(path.join(outside, 'config.toml'), 'utf8'), 'x = 1\n');
});
