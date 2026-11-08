// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { cleanEnv } from './clean-env.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const cli = join(root, 'packages/cli/bin/brainatlas.mjs');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

async function snapshotTree(base) {
  const result = new Map();
  async function visit(dir, rel = '') {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name); const path = rel ? `${rel}/${entry.name}` : entry.name; const stat = await lstat(file);
      if (stat.isDirectory() && !stat.isSymbolicLink()) await visit(file, path);
      else result.set(path, { sha256: stat.isSymbolicLink() ? sha(Buffer.from(await readlink(file))) : sha(await readFile(file)), mtimeMs: stat.mtimeMs, kind: stat.isSymbolicLink() ? 'symlink' : 'file' });
    }
  }
  await visit(base); return result;
}

function cliRun(env, ...args) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: root, env, encoding: 'utf8', shell: false });
}

test('migrate plan is read-only and reports paths and counts only', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'ba migrate plan-')); t.after(() => rm(temp, { recursive: true, force: true }));
  const home = join(temp, 'home'); const source = join(temp, 'old vault'); const target = join(temp, 'new vault');
  await mkdir(home); await cp(join(root, 'demo-vault'), source, { recursive: true });
  await mkdir(join(source, 'raw'), { recursive: true }); await writeFile(join(source, 'raw', 'bytes.bin'), Buffer.from([0, 255, 1, 128]));
  const env = cleanEnv({ HOME: home, PATH: process.env.PATH || '/usr/bin:/bin', BRAINATLAS_OFFLINE: '1' });
  const before = await snapshotTree(source);
  const result = cliRun(env, 'migrate', '--from', source, '--to', target, '--plan', '--json');
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.action, 'migrate'); assert.ok(plan.pages > 0); assert.ok(plan.files >= plan.pages); assert.ok(plan.bytes > 0);
  assert.ok(Array.isArray(plan.samplePaths) && plan.samplePaths.length <= 10);
  assert.ok(!result.stdout.includes('bytes.bin\u0000') && !result.stdout.includes('Wiki Index'));
  assert.deepEqual(await snapshotTree(source), before);
  await assert.rejects(lstat(target), { code: 'ENOENT' });
});

test('migrate copies selected bytes, skips internal files and links, and preserves source sha256 and mtime', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'ba migrate copy-')); t.after(() => rm(temp, { recursive: true, force: true }));
  const home = join(temp, 'home'); const source = join(temp, 'legacy'); const target = join(temp, 'adopted'); const outside = join(temp, 'outside.txt');
  await mkdir(home); await cp(join(root, 'demo-vault'), source, { recursive: true });
  await mkdir(join(source, 'raw'), { recursive: true }); const raw = Buffer.from([0, 255, 1, 128, 10]); await writeFile(join(source, 'raw', 'sample.bin'), raw);
  await mkdir(join(source, '.obsidian')); await writeFile(join(source, '.obsidian', 'workspace.json'), '{"pane":1}');
  await mkdir(join(source, '.trash')); await writeFile(join(source, '.trash', 'deleted.md'), 'private deleted note');
  await mkdir(join(source, '.git')); await writeFile(join(source, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  await writeFile(outside, 'external target'); await symlink(outside, join(source, 'wiki', 'external-link.md'));
  await writeFile(join(source, 'AGENTS.md'), '# Old policy\n\n## User instructions\nKeep my custom note.\n');
  await writeFile(join(source, 'CLAUDE.md'), '# Old Claude setup\n\nUser-only Claude note.\n');
  const env = cleanEnv({ HOME: home, PATH: process.env.PATH || '/usr/bin:/bin', BRAINATLAS_OFFLINE: '1' });
  const before = await snapshotTree(source);
  const result = cliRun(env, 'migrate', '--from', source, '--to', target, '--json');
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.bodyHashMatch, true); assert.equal(report.logPrefixPreserved, true); assert.equal(report.logAppendedEntries, 1);
  assert.ok(report.lintErrors >= 1); assert.ok(report.okfWarnings >= 1); assert.ok(report.skipped.git > 0); assert.equal(report.skipped.gitHistory, 'use git bundle, not copied'); assert.ok(report.skipped.obsidian > 0); assert.ok(report.skipped.trash > 0); assert.ok(report.skipped.symlinks > 0);
  assert.deepEqual(await readFile(join(target, 'raw', 'sample.bin')), raw);
  await assert.rejects(lstat(join(target, '.git')), { code: 'ENOENT' });
  await assert.rejects(lstat(join(target, '.obsidian')), { code: 'ENOENT' });
  await assert.rejects(lstat(join(target, '.trash')), { code: 'ENOENT' });
  await assert.rejects(lstat(join(target, 'wiki', 'external-link.md')), { code: 'ENOENT' });
  const agents = await readFile(join(target, 'AGENTS.md'), 'utf8'); const claude = await readFile(join(target, 'CLAUDE.md'), 'utf8');
  assert.match(agents, /migrated:user-section/); assert.match(agents, /Keep my custom note\./);
  assert.match(claude, /migrated:user-section/); assert.match(claude, /User-only Claude note\./);
  const sourceLog = await readFile(join(source, 'wiki/log.md')); const targetLog = await readFile(join(target, 'wiki/log.md'));
  assert.ok(targetLog.subarray(0, sourceLog.length).equals(sourceLog)); assert.match(targetLog.toString('utf8'), /"action":"migrated"/);
  const help = cliRun(env, 'help', 'migrate'); assert.equal(help.status, 0, help.stderr);
  for (const field of ['bodyHashMatch', 'logPrefixPreserved', 'logAppendedEntries']) assert.match(help.stdout, new RegExp(field));
  assert.deepEqual(await snapshotTree(source), before);
});

test('migrate refuses a non-empty destination without changing the source', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'ba migrate conflict-')); t.after(() => rm(temp, { recursive: true, force: true }));
  const home = join(temp, 'home'); const source = join(temp, 'legacy'); const target = join(temp, 'target');
  await mkdir(home); await cp(join(root, 'demo-vault'), source, { recursive: true }); await mkdir(target); await writeFile(join(target, 'keep'), 'keep');
  const env = cleanEnv({ HOME: home, PATH: process.env.PATH || '/usr/bin:/bin', BRAINATLAS_OFFLINE: '1' }); const before = await snapshotTree(source);
  const result = cliRun(env, 'migrate', '--from', source, '--to', target);
  assert.equal(result.status, 1); assert.match(result.stderr, /E_TARGET_NOT_EMPTY/);
  assert.deepEqual(await snapshotTree(source), before); assert.equal(await readFile(join(target, 'keep'), 'utf8'), 'keep');
});
