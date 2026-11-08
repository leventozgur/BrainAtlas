// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import * as adapter from '../../../packages/adapters/codex/src/index.mjs';

async function setup(t, internal, flag) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-retest-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const target = internal ? path.join(home, 'nested', 'codex') : path.join(root, 'outside');
  await mkdir(target, { recursive: true });
  await mkdir(home, { recursive: true });
  const original = 'model = "example"\n';
  await writeFile(path.join(target, 'config.toml'), original);
  await symlink(target, path.join(home, '.codex'), 'dir');
  const env = { HOME: home };
  if (flag !== undefined) env.BRAINATLAS_ALLOW_SYMLINKED_ROOT = flag;
  const ctx = { env, scope: 'global', paths: { stateDir: path.join(root, 'state') }, nodePath: '/usr/bin/node', shimPath: '/opt/example/brainatlas', now: new Date('2026-01-02T00:00:00Z') };
  return { target, original, ctx };
}
for (const flag of [undefined, '', '0', 'true']) {
  test(`outside HOME symlink denied with opt-in ${JSON.stringify(flag)}`, async t => {
    const f = await setup(t, false, flag);
    assert.throws(() => adapter.plan(f.ctx), { code: 'E_PATH_ESCAPE' });
    await assert.rejects(adapter.remove(f.ctx), { code: 'E_PATH_ESCAPE' });
    assert.deepEqual(await readdir(f.target), ['config.toml']);
    assert.equal(await readFile(path.join(f.target, 'config.toml'), 'utf8'), f.original);
  });
}
for (const [name, internal, flag] of [['outside opted in', false, '1'], ['inside HOME', true, undefined]]) {
  test(`${name} symlink supports full lifecycle`, async t => {
    const f = await setup(t, internal, flag);
    const plan = adapter.plan(f.ctx);
    await adapter.apply(plan, f.ctx);
    assert.match(await readFile(path.join(f.target, 'config.toml'), 'utf8'), /\[mcp_servers\.brainatlas\]/);
    await adapter.remove(f.ctx);
    assert.equal(await readFile(path.join(f.target, 'config.toml'), 'utf8'), f.original);
  });
}
test('retargeting a config directory after planning is rejected before writes', async t => {
  const f = await setup(t, true);
  const plan = adapter.plan(f.ctx);
  const link = path.join(f.ctx.env.HOME, '.codex');
  const outside = path.join(path.dirname(f.ctx.env.HOME), 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'config.toml'), f.original);
  await rm(link);
  await symlink(outside, link, 'dir');
  await assert.rejects(adapter.apply(plan, f.ctx), { code: 'E_PATH_ESCAPE' });
  assert.deepEqual(await readdir(outside), ['config.toml']);
  assert.equal(await readFile(path.join(outside, 'config.toml'), 'utf8'), f.original);
});
