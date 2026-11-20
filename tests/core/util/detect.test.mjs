// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectEvidence } from '../../../packages/core/src/index.mjs';

async function temp(t) {
  const base = await mkdtemp(join(tmpdir(), 'ba61-detect-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  return base;
}
const none = { detected: false, evidence: [] };

test('dirs and files match by kind, follow symlinks and report ~/ evidence', async (t) => {
  const home = await temp(t);
  const elsewhere = await temp(t);
  await symlink(elsewhere, join(home, '.linked'));
  await mkdir(join(home, '.real'));
  await writeFile(join(home, 'file.json'), '{}');
  await mkdir(join(home, 'dir.json'));
  const result = detectEvidence({
    env: { HOME: home },
    dirs: ['.linked', '.real', '.missing', 'file.json'],
    files: ['file.json', 'dir.json', '.real'],
  });
  assert.deepEqual(result, { detected: true, evidence: ['~/.linked', '~/.real', '~/file.json'] });
});

test('env override directories use their literal label, never the absolute path', async (t) => {
  const home = await temp(t);
  const custom = await temp(t);
  const result = detectEvidence({ env: { HOME: home }, dirs: [{ path: custom, label: '$CODEX_HOME' }] });
  assert.deepEqual(result, { detected: true, evidence: ['$CODEX_HOME'] });
});

test('globs match a name prefix inside a directory', async (t) => {
  const home = await temp(t);
  const glob = { dir: '.vscode/extensions', prefix: 'github.copilot' };
  assert.deepEqual(detectEvidence({ env: { HOME: home }, globs: [glob] }), none);
  await mkdir(join(home, '.vscode', 'extensions', 'ms-python.python-1'), { recursive: true });
  assert.deepEqual(detectEvidence({ env: { HOME: home }, globs: [glob] }), none);
  await mkdir(join(home, '.vscode', 'extensions', 'github.copilot-chat-1'));
  assert.deepEqual(detectEvidence({ env: { HOME: home }, globs: [glob] }), {
    detected: true,
    evidence: ['~/.vscode/extensions/github.copilot*'],
  });
});

test('commands need an executable regular file in an absolute PATH entry', async (t) => {
  const home = await temp(t);
  const bin = await temp(t);
  await writeFile(join(bin, 'tool'), '#!/bin/sh\n', { mode: 0o755 });
  await writeFile(join(bin, 'plain'), 'x', { mode: 0o644 });
  await mkdir(join(bin, 'folder'));
  await chmod(join(bin, 'folder'), 0o755);
  const run = (PATH, commands) => detectEvidence({ env: { HOME: home, PATH }, commands });
  assert.deepEqual(run(bin, ['tool']), { detected: true, evidence: ['PATH:tool'] });
  assert.deepEqual(run(bin, ['plain', 'folder', 'absent', 'a/b']), none);
  assert.deepEqual(run(`relative:${bin.slice(1)}`, ['tool']), none);
  assert.deepEqual(run('', ['tool']), none);
  assert.deepEqual(detectEvidence({ env: { HOME: home }, commands: ['tool'] }), none);
});

test('HOME missing, empty or relative returns not detected', async () => {
  for (const env of [undefined, null, {}, { HOME: '' }, { HOME: 'relative/home' }, { HOME: 5 }])
    assert.deepEqual(detectEvidence({ env, dirs: ['.x'], commands: ['sh'] }), none);
  assert.deepEqual(detectEvidence({ env: { HOME: '/', PATH: '/bin:/usr/bin' }, commands: ['sh'] }).evidence, [
    'PATH:sh',
  ]);
});

test('evidence order is dirs, files, globs, commands without duplicates or absolute paths', async (t) => {
  const home = await temp(t);
  const bin = await temp(t);
  await mkdir(join(home, '.a'));
  await mkdir(join(home, '.b'));
  await writeFile(join(home, '.f.json'), '{}');
  await mkdir(join(home, 'ext', 'pre-1'), { recursive: true });
  await writeFile(join(bin, 'cmd'), '#!/bin/sh\n', { mode: 0o755 });
  const result = detectEvidence({
    env: { HOME: home, PATH: `${bin}:${bin}` },
    commands: ['cmd', 'cmd'],
    globs: [{ dir: 'ext', prefix: 'pre' }],
    files: ['.f.json'],
    dirs: ['.b', '.a', '.b'],
  });
  assert.deepEqual(result.evidence, ['~/.b', '~/.a', '~/.f.json', '~/ext/pre*', 'PATH:cmd']);
  assert.equal(result.detected, true);
  for (const item of result.evidence) assert.equal(item.includes(home) || item.includes(bin), false);
});
