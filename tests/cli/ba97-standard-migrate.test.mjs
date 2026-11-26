// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolvePaths, vaultId } from '../../packages/core/src/index.mjs';
import { cleanEnv } from './clean-env.mjs';

const BIN = resolve('packages/cli/bin/brainatlas.mjs');
const BACKLOG_PAGE = '# Work backlog\n\n- ship the standard\n- review it\n';
const USER_SECTION =
  '<!-- migrated:user-section -->\n## My notes\nUse brainatlas frobnicate and wiki_missing_tool here.\n';

async function files(dir, prefix = '') {
  const out = new Map();
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) for (const [key, value] of await files(join(dir, entry.name), rel)) out.set(key, value);
    else out.set(rel, await readFile(join(dir, entry.name), 'utf8'));
  }
  return out;
}

async function fixture(t, agents = 'claude-code') {
  const base = await mkdtemp(join(tmpdir(), 'ba97-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = join(base, 'home');
  const vault = join(base, 'vault');
  await mkdir(home, { recursive: true });
  await mkdir(vault, { recursive: true });
  const env = cleanEnv({
    HOME: home,
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_DATA_HOME: join(home, 'data'),
    XDG_STATE_HOME: join(home, 'state'),
    BRAINATLAS_PLATFORM: 'linux',
    BRAINATLAS_OFFLINE: '1',
    PATH: process.env.PATH || '/usr/bin:/bin',
  });
  const paths = resolvePaths({ platform: 'linux', env });
  await mkdir(join(paths.dataDir, 'bin'), { recursive: true });
  await writeFile(join(paths.dataDir, 'bin', 'brainatlas'), '#!/bin/sh\n');
  const run = (...args) => spawnSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8', shell: false });
  const json = (...args) => {
    const result = run(...args, '--json');
    assert.equal(result.error, undefined);
    return { result, value: JSON.parse(result.stdout) };
  };
  const ok = (...args) => {
    const out = json(...args);
    assert.equal(out.result.status, 0, out.result.stderr + out.result.stdout);
    return out.value;
  };
  ok('init', '--yes', '--vault', vault, '--agents', agents);
  await rm(join(vault, '.brainatlas'), { recursive: true, force: true });
  const template = await readFile(resolve('templates/policy/AGENTS.md'), 'utf8');
  await writeFile(join(vault, 'AGENTS.md'), `${template}\n${USER_SECTION}`);
  await writeFile(join(vault, 'wiki/concepts/work-backlog.md'), BACKLOG_PAGE);
  await writeFile(join(vault, 'wiki/entities/keep.md'), '# Keep\n\nuser text\n');
  await writeFile(join(vault, 'raw/source.txt'), 'raw bytes\n');
  await mkdir(join(paths.stateDir, '0123456789abcdef'), { recursive: true });
  await writeFile(join(paths.stateDir, '0123456789abcdef', 'marker.json'), '{}');
  const own = join(paths.stateDir, vaultId(vault));
  await mkdir(own, { recursive: true });
  await writeFile(join(own, 'retrieval-index.json'), '{}');
  await writeFile(join(paths.stateDir, 'retrieval-index.json'), '{}');
  const adapterFile = join(home, '.claude.json');
  const backups = [];
  for (let day = 1; day <= 6; day++) {
    const name = `${adapterFile}.bak.2026-01-0${day}T00-00-00-000Z`;
    await writeFile(name, `backup ${day}`);
    await utimes(name, new Date(2026, 0, day), new Date(2026, 0, day));
    backups.push(name);
  }
  return { base, home, vault, env, paths, run, json, ok, backups };
}

const kinds = (value) => value.steps.map((step) => step.kind);

test('plan lists every drift step and changes nothing', async (t) => {
  const f = await fixture(t);
  const before = await files(f.vault);
  const plan = f.ok('standard', 'migrate');
  assert.equal(plan.action, 'standard-migrate');
  assert.equal(plan.mode, 'plan');
  assert.equal(plan.backupDir, null);
  assert.deepEqual(
    [...new Set(kinds(plan))],
    ['skeleton', 'standard', 'policy', 'planning-page', 'orphan-state', 'duplicate-index', 'adapter-backups']
  );
  const report = plan.steps.find((step) => step.kind === 'adapter-backups');
  assert.deepEqual([report.path, report.detail], ['~/.claude.json', 6]);
  assert.equal(kinds(plan).at(-1), 'adapter-backups');
  assert.ok(plan.warnings.some((warning) => warning.includes('frobnicate')));
  assert.deepEqual(await files(f.vault), before);
  assert.deepEqual(f.ok('standard', 'migrate', '--plan'), plan);
  const doctor = f.json('doctor').value;
  assert.ok(doctor.warnings.includes('Run brainatlas standard migrate to bring this vault to the standard.'));
});

test('apply backs up, moves verbatim, archives, reports and a second run plans nothing', async (t) => {
  const f = await fixture(t);
  const before = await files(f.vault);
  const result = f.ok('standard', 'migrate', '--apply');
  assert.equal(result.mode, 'apply');
  assert.equal(result.error, undefined);
  assert.match(result.backupDir, /^\.brainatlas\/migrations\/[0-9TZ-]+$/);
  const backupRoot = join(f.vault, result.backupDir);
  for (const rel of [
    'AGENTS.md',
    'wiki/concepts/work-backlog.md',
    'planning/backlog.md',
    'wiki/index.md',
    'wiki/log.md',
  ])
    assert.equal(await readFile(join(backupRoot, rel), 'utf8'), before.get(rel), rel);
  const report = JSON.parse(await readFile(join(backupRoot, 'report.json'), 'utf8'));
  assert.deepEqual(report.steps, result.steps);

  assert.equal(await readFile(join(f.vault, 'planning/projects/work-backlog.md'), 'utf8'), BACKLOG_PAGE);
  await assert.rejects(stat(join(f.vault, 'wiki/concepts/work-backlog.md')));
  const backlog = await readFile(join(f.vault, 'planning/backlog.md'), 'utf8');
  assert.match(
    backlog,
    /PRJ-001 \| Work backlog \| Moved from wiki\/concepts\/work-backlog\.md by standard migrate\. \|/
  );
  assert.match(backlog, /\| idea \|/);
  assert.match(await readFile(join(f.vault, 'wiki/log.md'), 'utf8'), /"action":"standard-migrate"/);
  assert.doesNotMatch(await readFile(join(f.vault, 'wiki/index.md'), 'utf8'), /work-backlog/);
  assert.match(await readFile(join(f.vault, 'AGENTS.md'), 'utf8'), /brainatlas:managed/);
  assert.ok((await readFile(join(f.vault, 'AGENTS.md'), 'utf8')).includes(USER_SECTION));
  await stat(join(f.vault, '.brainatlas/standard.json'));
  await stat(join(f.vault, 'planning/projects'));

  await assert.rejects(stat(join(f.paths.stateDir, '0123456789abcdef')));
  const archived = await readdir(join(f.paths.stateDir, 'archive'));
  assert.equal(archived.length, 1);
  assert.match(archived[0], /^0123456789abcdef-/);
  await stat(join(f.paths.stateDir, 'retrieval-index.json'));
  await assert.rejects(stat(join(f.paths.stateDir, vaultId(f.vault), 'retrieval-index.json')));
  for (const name of f.backups) await stat(name);

  const after = await files(f.vault);
  const changed = new Set(['AGENTS.md', 'wiki/index.md', 'wiki/log.md', 'planning/backlog.md']);
  for (const [rel, text] of before)
    if (!changed.has(rel) && rel !== 'wiki/concepts/work-backlog.md') assert.equal(after.get(rel), text, rel);

  const again = f.ok('standard', 'migrate');
  assert.deepEqual(kinds(again), ['adapter-backups']);
  const second = f.ok('standard', 'migrate', '--apply');
  assert.deepEqual(kinds(second), ['adapter-backups']);
  assert.equal(second.backupDir, null);
  for (const name of f.backups) await stat(name);
  assert.equal(second.backupDir, null);
  const doctor = f.json('doctor').value;
  assert.ok(!doctor.warnings.includes('Run brainatlas standard migrate to bring this vault to the standard.'));
});

test('prune keeps the newest three adapter backups only when asked', async (t) => {
  const f = await fixture(t);
  f.ok('standard', 'migrate', '--apply');
  for (const name of f.backups) await stat(name);
  const plan = f.ok('standard', 'migrate', '--prune-backups');
  assert.deepEqual(kinds(plan), ['adapter-backups']);
  assert.equal(plan.steps[0].detail, 6);
  f.ok('standard', 'migrate', '--apply', '--prune-backups');
  for (const name of f.backups.slice(0, 3)) await assert.rejects(stat(name));
  for (const name of f.backups.slice(3)) await stat(name);
  assert.deepEqual(f.ok('standard', 'migrate', '--prune-backups').steps, []);
});

test('a read-only configuration refuses apply and conflicting modes fail', async (t) => {
  const f = await fixture(t);
  f.ok('config', 'set', 'readOnly', 'true');
  const refused = f.json('standard', 'migrate', '--apply');
  assert.notEqual(refused.result.status, 0);
  assert.match(refused.result.stderr + refused.result.stdout, /E_READ_ONLY/);
  const both = f.run('standard', 'migrate', '--plan', '--apply');
  assert.notEqual(both.status, 0);
});

test('the policy step backs up every file the refresh changes', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.vault, 'CLAUDE.md'), '<!-- migrated:user-section -->\n# my claude notes\n');
  const plan = f.ok('standard', 'migrate');
  const policy = plan.steps.find((step) => step.kind === 'policy');
  assert.match(policy.path, /AGENTS\.md/);
  assert.match(policy.path, /CLAUDE\.md/);
  const result = f.ok('standard', 'migrate', '--apply');
  const root = join(f.vault, result.backupDir);
  assert.equal(await readFile(join(root, 'CLAUDE.md'), 'utf8'), '<!-- migrated:user-section -->\n# my claude notes\n');
  assert.ok((await readFile(join(root, 'AGENTS.md'), 'utf8')).includes(USER_SECTION));
});

test('a symlinked vault directory is planned around and refused on apply', async (t) => {
  const f = await fixture(t);
  const outside = join(f.base, 'outside');
  await mkdir(outside);
  await rm(join(f.vault, 'planning'), { recursive: true, force: true });
  await symlink(outside, join(f.vault, 'planning'));
  const plan = f.ok('standard', 'migrate');
  assert.ok(plan.warnings.some((warning) => warning.startsWith('planning:')));
  assert.ok(!kinds(plan).includes('planning-page'));
  const refused = f.json('standard', 'migrate', '--apply');
  assert.notEqual(refused.result.status, 0);
  assert.match(refused.result.stdout + refused.result.stderr, /E_PATH_ESCAPE/);
  assert.deepEqual(await readdir(outside), []);
  await stat(join(f.vault, 'wiki/concepts/work-backlog.md'));
});

test('a failing planning-page move rolls back and a rerun creates one project', async (t) => {
  const f = await fixture(t);
  const dir = join(f.vault, 'wiki/concepts');
  await chmod(dir, 0o555);
  t.after(() => chmod(dir, 0o755).catch(() => {}));
  const failed = f.json('standard', 'migrate', '--apply').value;
  assert.equal(failed.error.rolledBack, true);
  assert.match(failed.error.step, /^planning-page:/);
  assert.equal(await readFile(join(dir, 'work-backlog.md'), 'utf8'), BACKLOG_PAGE);
  await assert.rejects(stat(join(f.vault, 'planning/projects/work-backlog.md')));
  assert.doesNotMatch(await readFile(join(f.vault, 'planning/backlog.md'), 'utf8'), /PRJ-001/);
  await chmod(dir, 0o755);
  const rerun = f.ok('standard', 'migrate', '--apply');
  assert.equal(rerun.error, undefined);
  const backlog = await readFile(join(f.vault, 'planning/backlog.md'), 'utf8');
  assert.equal(backlog.match(/PRJ-\d+ \|/g).length, 1);
  assert.deepEqual(await readdir(join(f.vault, 'planning/projects')), ['work-backlog.md']);
});

test('adapter backups honour the configured agents and an unreadable install manifest', async (t) => {
  const other = await fixture(t, 'codex');
  assert.ok(!kinds(other.ok('standard', 'migrate')).includes('adapter-backups'));
  const f = await fixture(t);
  await mkdir(join(f.paths.installManifest, '..'), { recursive: true });
  await writeFile(f.paths.installManifest, '{not json');
  const plan = f.ok('standard', 'migrate');
  assert.ok(
    plan.warnings.includes('Install manifest could not be read (E_MANIFEST_INVALID); adapter backups were not checked.')
  );
  assert.ok(!kinds(plan).includes('adapter-backups'));
});

test('a failing second move leaves the first move kept and rolls back only the second', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.vault, 'wiki/entities/zz-todo.md'), '# Later\n\n- second page\n');
  const dir = join(f.vault, 'wiki/entities');
  await chmod(dir, 0o555);
  let failed;
  try {
    failed = f.json('standard', 'migrate', '--apply').value;
  } finally {
    await chmod(dir, 0o755);
  }
  assert.equal(failed.error.rolledBack, true);
  assert.equal(failed.error.step, 'planning-page:wiki/entities/zz-todo.md');
  assert.equal(await readFile(join(f.vault, 'planning/projects/work-backlog.md'), 'utf8'), BACKLOG_PAGE);
  await assert.rejects(stat(join(f.vault, 'planning/projects/zz-todo.md')));
  await stat(join(dir, 'zz-todo.md'));
  const backlog = await readFile(join(f.vault, 'planning/backlog.md'), 'utf8');
  assert.match(backlog, /PRJ-001 \| Work backlog/);
  assert.doesNotMatch(backlog, /PRJ-002/);
});

test('a page the secret filter would refuse never triggers the doctor suggestion', async (t) => {
  const f = await fixture(t);
  f.ok('standard', 'migrate', '--apply', '--prune-backups');
  const marker = ['-----BEGIN', 'RSA', 'PRIVATE', 'KEY-----'].join(' ');
  await writeFile(join(f.vault, 'wiki/concepts/key-todo.md'), `# Key\n\n${marker}\nabc\n`);
  const plan = f.ok('standard', 'migrate');
  assert.deepEqual(plan.steps, []);
  assert.ok(plan.warnings.some((warning) => warning.includes('secret-like')));
  const doctor = f.json('doctor').value;
  assert.ok(!doctor.warnings.includes('Run brainatlas standard migrate to bring this vault to the standard.'));
});
