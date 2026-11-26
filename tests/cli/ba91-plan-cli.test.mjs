// SPDX-License-Identifier: MIT
// BA-91: `brainatlas plan` runs the plan_read/plan_update MCP handlers in process. Hermetic: temporary HOME and vault.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { cleanEnv } from './clean-env.mjs';

const BIN = resolve('packages/cli/bin/brainatlas.mjs');

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'ba91-plan-cli-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = join(base, 'home');
  await mkdir(home, { recursive: true });
  const env = cleanEnv({
    HOME: home,
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_DATA_HOME: join(home, 'data'),
    XDG_STATE_HOME: join(home, 'state'),
    BRAINATLAS_PLATFORM: 'linux',
    BRAINATLAS_OFFLINE: '1',
    PATH: process.env.PATH || '/usr/bin:/bin',
  });
  const vault = join(base, 'vault');
  const run = (args, options = {}) =>
    spawnSync(process.execPath, [BIN, ...args], {
      env: options.env ?? env,
      encoding: 'utf8',
      shell: false,
      timeout: 30000,
    });
  const init = run(['init', '--yes', '--vault', vault, '--json']);
  assert.equal(init.status, 0, init.stderr);
  const configFile = join(home, 'config', 'brainatlas', 'config.json');
  const json = (...args) => {
    const result = run([...args, '--json']);
    assert.equal(result.error, undefined, 'command timed out');
    return { result, value: JSON.parse(result.stdout) };
  };
  return { base, home, env, vault, configFile, run, json };
}

test('plan help documents the subcommands and an unknown sub is E_ARGUMENT', async (t) => {
  const f = await fixture(t);
  const help = f.run(['help', 'plan']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /brainatlas plan list/);
  assert.match(help.stdout, /show <project>/);
  assert.match(help.stdout, /new <slug> --title/);
  assert.match(help.stdout, /add <project>/);
  assert.match(help.stdout, /set <project>/);
  const unknown = f.json('plan', 'bogus');
  assert.equal(unknown.result.status, 1);
  assert.equal(unknown.value.error.code, 'E_ARGUMENT');
  assert.equal(unknown.value.error.message, 'plan requires one of: list, show, new, add, set.');
});

test('plan new, add, set and list write the standard layout through the MCP handlers', async (t) => {
  const f = await fixture(t);
  const created = f.json('plan', 'new', 'demo', '--title', 'Demo', '--purpose', 'Build it');
  assert.equal(created.result.status, 0, created.result.stderr);
  assert.equal(created.value.op, 'add_project');
  assert.equal(created.value.id, 'PRJ-001');
  assert.equal(created.value.file, 'planning/projects/demo.md');

  const added = f.json('plan', 'add', 'demo', 'Fix', 'the', 'bug', '--id', 'BA-1');
  assert.equal(added.result.status, 0, added.result.stderr);
  assert.equal(added.value.id, 'BA-1');
  const project = await readFile(join(f.vault, 'planning/projects/demo.md'), 'utf8');
  assert.match(project, /- \[ready\] BA-1 · Fix the bug \(\d{4}-\d{2}-\d{2}\)\n/);

  const setTask = f.json('plan', 'set', 'demo', 'BA-1', 'in_progress');
  assert.equal(setTask.result.status, 0, setTask.result.stderr);
  assert.equal(setTask.value.op, 'set_status');
  const setProject = f.json('plan', 'set', 'demo', 'done');
  assert.equal(setProject.result.status, 0, setProject.result.stderr);
  assert.match(await readFile(join(f.vault, 'planning/projects/demo.md'), 'utf8'), /Status: done/);
  const backlog = await readFile(join(f.vault, 'planning/backlog.md'), 'utf8');
  assert.ok(backlog.includes('| PRJ-001 | Demo | Build it | — | done |'));

  const list = f.json('plan', 'list');
  assert.equal(list.result.status, 0, list.result.stderr);
  assert.equal(list.value.projects.length, 1);
  assert.equal(list.value.projects[0].title, 'Demo');
  const human = f.run(['plan', 'list']);
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /^PRJ-001 · Demo · done · projects\/demo\.md$/m);
});

test('plan show and human write output', async (t) => {
  const f = await fixture(t);
  assert.equal(f.run(['plan', 'new', 'demo', '--title', 'Demo', '--purpose', 'Build it']).status, 0);
  assert.equal(f.run(['plan', 'add', 'demo', 'One', 'task']).status, 0);
  const shown = f.json('plan', 'show', 'demo');
  assert.equal(shown.result.status, 0, shown.result.stderr);
  assert.equal(shown.value.id, 'PRJ-001');
  assert.equal(shown.value.tasks[0].title, 'One task');
  assert.equal(shown.value.file, 'projects/demo.md');
  const human = f.run(['plan', 'show', 'demo']);
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /PRJ-001-1 · One task \[ready\]/);
  const writeHuman = f.run(['plan', 'add', 'demo', 'Another']);
  assert.equal(writeHuman.status, 0, writeHuman.stderr);
  assert.match(writeHuman.stdout, /^add_task: planning\/projects\/demo\.md$/m);
});

test('plan dry-run and expected SHA-256 change nothing on disk', async (t) => {
  const f = await fixture(t);
  const created = f.json('plan', 'new', 'demo', '--title', 'Demo', '--purpose', 'Build it');
  const before = await readFile(join(f.vault, 'planning/projects/demo.md'), 'utf8');
  const dry = f.json('plan', 'add', 'demo', 'Dry', 'run', '--dry-run', '--expect-sha256', created.value.sha256);
  assert.equal(dry.result.status, 0, dry.result.stderr);
  assert.equal(dry.value.dryRun, true);
  assert.equal(await readFile(join(f.vault, 'planning/projects/demo.md'), 'utf8'), before);
  const dryHuman = f.run(['plan', 'add', 'demo', 'Dry', 'human', '--dry-run']);
  assert.equal(dryHuman.status, 0, dryHuman.stderr);
  assert.equal(dryHuman.stdout.trim(), 'dry run: add_task: planning/projects/demo.md');
  const stale = f.json('plan', 'add', 'demo', 'Stale', '--expect-sha256', '0'.repeat(64));
  assert.equal(stale.result.status, 1);
  assert.match(stale.value.error.code, /^E_CONFLICT$/);
  assert.equal(await readFile(join(f.vault, 'planning/projects/demo.md'), 'utf8'), before);
});

test('the read-only vault refuses plan writes with E_READ_ONLY but still lists', async (t) => {
  const f = await fixture(t);
  assert.equal(f.json('plan', 'new', 'demo', '--title', 'Demo', '--purpose', 'Build it').result.status, 0);
  const config = JSON.parse(await readFile(f.configFile, 'utf8'));
  config.readOnly = true;
  await writeFile(f.configFile, JSON.stringify(config));
  const list = f.json('plan', 'list');
  assert.equal(list.result.status, 0, list.result.stderr);
  const refused = f.json('plan', 'new', 'other', '--title', 'Other', '--purpose', 'Nothing');
  assert.equal(refused.result.status, 1);
  assert.equal(refused.value.error.code, 'E_READ_ONLY');
  assert.equal(refused.value.error.message, 'The vault is read-only (readOnly: true).');
});

test('plan argument errors name the problem before any write', async (t) => {
  const f = await fixture(t);
  for (const args of [
    ['new', 'demo', '--purpose', 'P'],
    ['new', 'demo', '--title', 'T'],
    ['add', 'demo'],
    ['set', 'demo'],
    ['show'],
    ['list', 'extra'],
    ['show', 'demo', '--max-chars', 'x'],
    ['new', 'demo', '--title', 'T', '--purpose', 'P', '--expect-sha256', 'short'],
    ['new', 'demo', '--title', 'T', '--purpose', 'P', '--bogus'],
  ]) {
    const failed = f.json('plan', ...args);
    assert.equal(failed.result.status, 1, args.join(' '));
    assert.equal(failed.value.error.code, 'E_ARGUMENT', args.join(' '));
  }
});
