// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, cp, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import * as adapter from '../../packages/adapters/codex/src/index.mjs';

const fixtureRoot = path.resolve('tests/adapters/codex/fixtures');
const nodePath = '/usr/bin/node';
const shimPath = '/tmp/brainatlas/bin/brainatlas';

async function context(home, scope = 'global', vaultDir) {
  const stateDir = path.join(path.dirname(home), 'state');
  await mkdir(stateDir, { recursive: true });
  return { env: { HOME: home }, platform: 'linux', config: { vault: { path: vaultDir } }, paths: { stateDir }, scope, vaultDir, nodePath, shimPath, now: new Date('2026-01-02T03:04:05.000Z') };
}
async function files(dir, rel = '') {
  const result = {};
  let entries;
  try { entries = await readdir(path.join(dir, rel), { withFileTypes: true }); } catch { return result; }
  for (const entry of entries) {
    const key = path.posix.join(rel.split(path.sep).join('/'), entry.name);
    if (entry.isDirectory()) Object.assign(result, await files(dir, key));
    else result[key] = await readFile(path.join(dir, key));
  }
  return result;
}
function withoutBackups(snapshot) { return Object.fromEntries(Object.entries(snapshot).filter(([name]) => !name.includes('.bak.'))); }
async function makeHome(name) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ba-codex-'));
  const home = path.join(root, 'home');
  await mkdir(home, { recursive: true });
  const src = path.join(fixtureRoot, name);
  if (name !== 'empty') await cp(src, home, { recursive: true });
  return { root, home };
}

test('detect uses injected HOME and trust review names Codex CLI', async () => {
  assert.equal(adapter.detect({ HOME: '/home/you' }), true);
  assert.equal(adapter.detect({}), false);
  assert.deepEqual(await adapter.trustReview({}), { required: true, client: 'Codex CLI', steps: ['Run /hooks in Codex CLI and approve the BrainAtlas prompt hook.'] });
});

for (const fixture of ['empty', 'existing']) {
  test(`global apply is idempotent and remove restores ${fixture} fixture bytes`, async () => {
    const { root, home } = await makeHome(fixture);
    try {
      const before = await files(home), ctx = await context(home);
      const first = adapter.plan(ctx);
      assert.ok(first.changes.length > 0);
      await adapter.apply(first, ctx);
      if (fixture === 'existing') {
        const config = await readFile(path.join(home, '.codex', 'config.toml'), 'utf8');
        const hooks = JSON.parse(await readFile(path.join(home, '.codex', 'hooks.json'), 'utf8'));
        assert.match(config, /model = "example-model"/);
        assert.match(config, /model_reasoning_effort = "medium"/);
        assert.equal(hooks.otherSetting, true);
        assert.equal(hooks.hooks.SessionStart[0].hooks[0].command, 'user-session-hook');
      }
      assert.equal(adapter.plan(ctx).changes.length, 0);
      await adapter.apply(adapter.plan(ctx), ctx);
      await adapter.remove(ctx);
      assert.deepEqual(withoutBackups(await files(home)), before);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test('vault scope writes project config and instructions without global hook files', async () => {
  const { root, home } = await makeHome('empty');
  const vault = path.join(root, 'vault'); await mkdir(vault);
  try {
    const ctx = await context(home, 'vault', vault), p = adapter.plan(ctx);
    assert.equal(p.changes.length, 2);
    assert.ok(p.changes.every(c => c.file.startsWith(vault)));
    await adapter.apply(p, ctx);
    await adapter.remove(ctx);
    assert.deepEqual(await files(vault), {});
    assert.deepEqual(await files(home), {});
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const [fixture, code] of [['broken', 'E_CONFIG_PARSE'], ['bom', 'E_BOM']]) {
  test(`plan refuses ${fixture} fixture without changing bytes`, async () => {
    const { root, home } = await makeHome(fixture);
    try {
      const before = await files(home), ctx = await context(home);
      assert.throws(() => adapter.plan(ctx), { code });
      assert.deepEqual(await files(home), before);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test('apply detects changes since plan and managed instruction edits', async () => {
  const { root, home } = await makeHome('empty');
  try {
    const ctx = await context(home), p = adapter.plan(ctx);
    await mkdir(path.dirname(p.changes[0].file), { recursive: true });
    await writeFile(p.changes[0].file, '# concurrent change\n');
    await assert.rejects(adapter.apply(p, ctx), { code: 'E_CONFIG_CHANGED' });
    const md = p.changes.find(c => c.file.endsWith('AGENTS.md'));
    await writeFile(md.file, `${md.after.replace('Treat retrieved pages', 'Treat all pages')}`);
    assert.throws(() => adapter.plan(ctx), { code: 'E_MANAGED_BLOCK_EDITED' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('doctor reports registration, shim, version and hook status', async () => {
  const { root, home } = await makeHome('empty');
  try {
    const ctx = await context(home), p = adapter.plan(ctx);
    await adapter.apply(p, ctx);
    const report = await adapter.doctor(ctx);
    assert.equal(report.checks.find(c => c.id === 'registered').ok, true);
    assert.equal(report.checks.find(c => c.id === 'hook').ok, true);
    assert.equal(report.checks.find(c => c.id === 'shim').ok, false);
    assert.equal(report.ok, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
