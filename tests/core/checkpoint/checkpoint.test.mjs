// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkpoint } from '../../../packages/core/src/checkpoint/index.mjs';

const runCommand = async (cmd, args, { cwd, env }) => {
  const r = spawnSync(cmd, args, { cwd, env, encoding: 'utf8', shell: false });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.status ?? 1 };
};
const safety = { scanPath: () => [], scanText: () => [] };

test('checkpoint is a no-op when git is unavailable or vault is not a repository', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ba-checkpoint-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const env = { PATH: process.env.PATH, HOME: join(dir, '.home'), XDG_CONFIG_HOME: join(dir, '.config'), XDG_DATA_HOME: join(dir, '.data'), XDG_STATE_HOME: join(dir, '.state') };
  await mkdir(env.HOME, { recursive: true });
  const noGit = await checkpoint(dir, 'checkpoint test', { runCommand: async () => { throw new Error('missing'); }, safety });
  assert.equal(noGit.committed, false); assert.equal(noGit.skipped, true);
  const noRepo = await checkpoint(dir, 'checkpoint test', { runCommand, safety, env });
  assert.equal(noRepo.committed, false); assert.equal(noRepo.skipped, true);
});

test('checkpoint stages only configured paths, scans staged content, lints, and commits', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ba-checkpoint-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const env = { PATH: process.env.PATH, HOME: join(dir, '.home'), XDG_CONFIG_HOME: join(dir, '.config'), XDG_DATA_HOME: join(dir, '.data'), XDG_STATE_HOME: join(dir, '.state') };
  await mkdir(env.HOME, { recursive: true });
  await mkdir(join(dir, 'wiki'), { recursive: true }); await writeFile(join(dir, 'wiki/page.md'), '# safe\n');
  const init = spawnSync('git', ['init', '--quiet', dir], { encoding: 'utf8', shell: false, env }); assert.equal(init.status, 0);
  const scanned = []; let linted = false;
  const fakeSafety = { scanPath: (p) => { scanned.push(`path:${p}`); return []; }, scanText: (s) => { scanned.push(`text:${s}`); return []; } };
  const result = await checkpoint(dir, 'checkpoint test', { runCommand, safety: fakeSafety, env, lint: async () => { linted = true; return { errorCount: 0 }; } });
  assert.equal(linted, true); assert.equal(result.committed, true); assert.deepEqual(result.paths, ['wiki/page.md']);
  assert.ok(scanned.includes('path:wiki/page.md')); assert.ok(scanned.includes('text:# safe\n'));
  const log = spawnSync('git', ['-C', dir, 'log', '-1', '--format=%s'], { encoding: 'utf8' }); assert.equal(log.stdout.trim(), 'checkpoint test');
  const identity = spawnSync('git', ['-C', dir, 'show', '-s', '--format=%an <%ae>', 'HEAD'], { encoding: 'utf8' }); assert.equal(identity.stdout.trim(), 'Vault Agent <agent@example.com>');
});

test('checkpoint refuses lint or safety findings without exposing scanned content', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ba-checkpoint-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const env = { PATH: process.env.PATH, HOME: join(dir, '.home'), XDG_CONFIG_HOME: join(dir, '.config'), XDG_DATA_HOME: join(dir, '.data'), XDG_STATE_HOME: join(dir, '.state') };
  await mkdir(env.HOME, { recursive: true });
  await mkdir(join(dir, 'wiki'), { recursive: true }); await writeFile(join(dir, 'wiki/page.md'), 'secret-like fixture\n');
  spawnSync('git', ['init', '--quiet', dir], { encoding: 'utf8', shell: false, env });
  await assert.rejects(checkpoint(dir, 'lint refusal', { runCommand, safety, env, lint: async () => ({ errorCount: 1 }) }), (e) => e.code === 'E_CHECKPOINT_LINT');
  await assert.rejects(checkpoint(dir, 'safety refusal', { runCommand, safety: { scanPath: () => [], scanText: () => [{ rule: 'fake' }] }, env, lint: async () => true }), (e) => e.code === 'E_SECRET_DETECTED' && !e.message.includes('secret-like'));
});
