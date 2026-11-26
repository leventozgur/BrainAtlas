// SPDX-License-Identifier: MIT
// BA-90: doctor/status report per-agent capabilities, hook activity, orphan state and write-path warnings.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolvePaths, vaultId } from '../../packages/core/src/index.mjs';
import { doctorResult } from '../../packages/cli/src/commands/lifecycle.mjs';
import { cleanEnv } from './clean-env.mjs';

const BIN = resolve('packages/cli/bin/brainatlas.mjs');
const DAY = 24 * 60 * 60 * 1000;

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'ba90-doctor-'));
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
  const stateDir = join(paths.stateDir, vaultId(vault));
  await mkdir(join(paths.dataDir, 'bin'), { recursive: true });
  await writeFile(join(paths.dataDir, 'bin', 'brainatlas'), '#!/bin/sh\n');
  const run = (...args) => spawnSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8', shell: false });
  const json = (...args) => {
    const result = run(...args, '--json');
    assert.equal(result.error, undefined, `${args.join(' ')} timed out`);
    return { result, value: JSON.parse(result.stdout) };
  };
  const ok = (...args) => {
    const out = json(...args);
    assert.equal(out.result.status, 0, out.result.stderr + out.result.stdout);
    return out.value;
  };
  const release = async () => {
    await mkdir(join(paths.releasesDir, 'ba90'), { recursive: true });
    await symlink('releases/ba90', paths.currentDir);
  };
  const hooks = async (records) => {
    await mkdir(join(stateDir, 'metrics'), { recursive: true });
    await writeFile(join(stateDir, 'metrics', 'hooks.jsonl'), `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);
  };
  return { home, vault, env, paths, stateDir, run, json, ok, release, hooks };
}

test('doctor and status report capabilities, hook activity and orphan state', async (t) => {
  const f = await fixture(t);
  f.ok('init', '--yes', '--vault', f.vault, '--agents', 'claude-code,codex,kiro');
  await f.release();
  const now = Date.now();
  const claudeAt = new Date(now - 2 * DAY).toISOString();
  const codexAt = new Date(now - 9 * DAY).toISOString();
  await f.hooks([
    { ts: claudeAt, client: 'claude', event: 'prompt' },
    { ts: new Date(now - 2 * DAY - 1000).toISOString(), client: 'claude', event: 'session-start' },
    { ts: codexAt, client: 'codex', event: 'prompt' },
  ]);
  await mkdir(join(f.paths.stateDir, '0123456789abcdef'));

  const doctor = f.ok('doctor');
  assert.deepEqual(doctor.capabilities, {
    'claude-code': { channel: 'mcp', read: true, write: true, inject: 'prompt' },
    codex: { channel: 'mcp', read: true, write: true, inject: 'prompt' },
    kiro: { channel: 'mcp', read: true, write: true, inject: 'prompt' },
  });
  assert.equal(doctor.ok, true);
  assert.equal(doctor.hookActivity['claude-code'].lastHookAt, claudeAt);
  assert.equal(doctor.hookActivity.codex.lastHookAt, codexAt);
  assert.equal(doctor.hookActivity.kiro.lastHookAt, null);
  assert.ok(doctor.warnings.includes('kiro hook is installed but has never run.'));
  assert.ok(doctor.warnings.includes('codex hook last ran 9 days ago.'));
  assert.ok(!doctor.warnings.some((warning) => warning.startsWith('claude-code hook')));
  assert.deepEqual(doctor.orphanState, ['0123456789abcdef']);
  assert.ok(
    doctor.warnings.includes(
      'State directory 0123456789abcdef does not belong to the configured vault; remove it after checking.'
    )
  );

  const status = f.ok('status');
  assert.deepEqual(status.capabilities, doctor.capabilities);
  assert.deepEqual(status.hookActivity, doctor.hookActivity);
  assert.deepEqual(status.orphanState, doctor.orphanState);

  const summary = f.ok('status', '--summary');
  assert.deepEqual(summary.capabilities, doctor.capabilities);
  const human = f.run('status', '--summary');
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /^claude-code: mcp, read yes, write yes, inject prompt$/m);
  assert.match(human.stdout, /^kiro: mcp, read yes, write yes, inject prompt$/m);
});

test('doctorResult counts numeric timestamps and uses the injected now for the seven-day rule', async (t) => {
  const f = await fixture(t);
  f.ok('init', '--yes', '--vault', f.vault, '--agents', 'claude-code,codex,kiro');
  await f.release();
  const fixed = new Date('2026-11-20T00:00:00.000Z');
  const eightDays = new Date(fixed.getTime() - 8 * DAY);
  const sevenDays = new Date(fixed.getTime() - 7 * DAY);
  await f.hooks([
    { ts: eightDays.getTime(), client: 'claude', event: 'session-start' },
    { ts: sevenDays.toISOString(), client: 'codex', event: 'prompt' },
  ]);
  const doctor = await doctorResult(f.paths, f.env, fixed);
  assert.equal(doctor.hookActivity['claude-code'].lastHookAt, eightDays.toISOString());
  assert.equal(doctor.hookActivity.codex.lastHookAt, sevenDays.toISOString());
  assert.ok(doctor.warnings.includes('claude-code hook last ran 8 days ago.'));
  assert.ok(!doctor.warnings.some((warning) => warning.startsWith('codex hook')));
  assert.ok(doctor.warnings.includes('kiro hook is installed but has never run.'));
  assert.equal(doctor.ok, true);
});

test('unreadable hook metrics produce one warning and suppress never-run warnings', async (t) => {
  const f = await fixture(t);
  f.ok('init', '--yes', '--vault', f.vault, '--agents', 'claude-code,kiro');
  await f.release();
  await mkdir(join(f.stateDir, 'metrics', 'hooks.jsonl'), { recursive: true });
  const doctor = await doctorResult(f.paths, f.env, new Date());
  assert.ok(doctor.warnings.includes('Hook metrics could not be read (EISDIR).'));
  assert.ok(!doctor.warnings.some((warning) => warning.includes('never run')));
  assert.equal(doctor.ok, true);
});

test('an unreadable state directory adds one warning without changing ok', async (t) => {
  const f = await fixture(t);
  f.ok('init', '--yes', '--vault', f.vault, '--agents', 'claude-code');
  await f.release();
  await mkdir(join(f.home, 'state'), { recursive: true });
  await rm(f.paths.stateDir, { recursive: true, force: true });
  await writeFile(f.paths.stateDir, 'not a directory\n');
  const doctor = await doctorResult(f.paths, f.env, new Date());
  assert.ok(doctor.warnings.includes('State directory could not be read (ENOTDIR).'));
  assert.equal(doctor.ok, true);
});

test('a cli channel warns about the missing write path, read-only never does', async (t) => {
  const cli = await fixture(t);
  await mkdir(join(cli.paths.dataDir, 'bin'), { recursive: true });
  await writeFile(join(cli.paths.dataDir, 'bin', 'brainatlas'), '#!/bin/sh\n');
  cli.ok('init', '--yes', '--vault', cli.vault, '--agents', 'claude-code', '--channel', 'cli');
  await cli.release();
  const cliDoctor = cli.ok('doctor');
  assert.deepEqual(cliDoctor.capabilities['claude-code'], {
    channel: 'cli',
    read: true,
    write: false,
    inject: 'none',
  });
  assert.ok(
    cliDoctor.warnings.includes(
      'claude-code has no write path (channel cli); run brainatlas agent refresh claude-code.'
    )
  );

  const readOnly = await fixture(t);
  readOnly.ok('init', '--yes', '--vault', readOnly.vault, '--agents', 'claude-code');
  await readOnly.release();
  readOnly.ok('config', 'set', 'readOnly', 'true');
  const doctor = readOnly.ok('doctor');
  assert.equal(doctor.capabilities['claude-code'].write, false);
  assert.ok(!doctor.warnings.some((warning) => warning.includes('has no write path')));
});
