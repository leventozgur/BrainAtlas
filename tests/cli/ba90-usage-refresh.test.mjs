// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { defaultConfig, resolvePaths } from '../../packages/core/src/index.mjs';
import { formatUsage, usageSummary } from '../../packages/cli/src/usage.mjs';
import { cleanEnv } from './clean-env.mjs';

const BIN = resolve('packages/cli/bin/brainatlas.mjs');

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'ba90-refresh-'));
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
  const run = (...args) => spawnSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8', shell: false });
  const json = (...args) => {
    const result = run(...args, '--json');
    assert.equal(result.error, undefined, `${args.join(' ')} timed out`);
    let value = null;
    try {
      value = JSON.parse(result.stdout);
      // eslint-disable-next-line no-empty
    } catch {}
    return { result, value };
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
  return { home, vault, env, paths, run, json, ok, release };
}

const exists = (file) =>
  stat(file).then(
    () => true,
    () => false
  );

test('usage keeps its old aggregates and adds events, byClient and the metrics path', async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), 'ba90-usage-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  await mkdir(join(stateDir, 'metrics'), { recursive: true });
  const now = new Date('2026-11-20T00:00:00.000Z');
  const at = (days) => new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
  const records = [
    { ts: at(1), client: 'claude', event: 'prompt', outcome: 'ok', results: 2, chars: 10, durationMs: 5 },
    { ts: at(2), client: 'claude', event: 'session-start' },
    { ts: at(3), client: 'codex', event: 'session-start' },
    { ts: at(4), event: 'session-start' },
    { ts: at(10), client: 'kiro', event: 'prompt', outcome: 'ok', results: 1, chars: 1, durationMs: 1 },
  ];
  await writeFile(
    join(stateDir, 'metrics', 'hooks.jsonl'),
    `${records.map((record) => JSON.stringify(record)).join('\n')}\nnot-json\n`
  );
  const summary = await usageSummary({ stateDir, days: 7, now });
  assert.equal(summary.prompts, 1);
  assert.equal(summary.stateDir, stateDir);
  assert.deepEqual(summary.events, { prompt: 1, 'session-start': 3 });
  assert.deepEqual(summary.byClient, {
    claude: { prompt: 1, 'session-start': 1, lastAt: at(1) },
    codex: { prompt: 0, 'session-start': 1, lastAt: at(3) },
  });
  const text = formatUsage(summary);
  assert.match(text, /^Events: prompt 1, session-start 3$/m);
  assert.match(text, /^ {2}claude: prompt 1, session-start 1, last 2026-11-19T00:00:00.000Z$/m);
  assert.match(text, /^ {2}codex: prompt 0, session-start 1, last 2026-11-17T00:00:00.000Z$/m);
  assert.ok(!text.includes('kiro:'));
  assert.ok(text.endsWith(`Metrics: ${join(stateDir, 'metrics', 'hooks.jsonl')}`));
});

test('agent refresh plans and re-applies configured adapters only', async (t) => {
  const f = await fixture(t);
  f.ok('init', '--yes', '--vault', f.vault, '--agents', 'claude-code,kiro');
  const planned = f.ok('agent', 'refresh', '--plan');
  assert.equal(planned.action, 'agent-refresh');
  assert.deepEqual(
    planned.agents.map((item) => item.agent),
    ['claude-code', 'kiro']
  );
  assert.ok(planned.agents.every((item) => Array.isArray(item.changed) && Array.isArray(item.warnings)));
  assert.equal(await exists(join(f.home, '.kiro', 'settings', 'mcp.json')), true);

  const single = f.ok('agent', 'refresh', 'kiro', '--plan');
  assert.deepEqual(
    single.agents.map((item) => item.agent),
    ['kiro']
  );

  const unknown = f.json('agent', 'refresh', 'codex');
  assert.equal(unknown.result.status, 1);
  assert.equal(unknown.value.error.code, 'E_ARGUMENT');
  assert.equal(unknown.value.error.message, 'Agent codex is not installed.');

  await rm(join(f.home, '.kiro', 'settings', 'mcp.json'));
  const refreshed = f.ok('agent', 'refresh', 'kiro');
  assert.equal(refreshed.agents[0].agent, 'kiro');
  assert.ok(refreshed.agents[0].changed.some((file) => file.endsWith('.kiro/settings/mcp.json')));
  assert.equal(await exists(join(f.home, '.kiro', 'settings', 'mcp.json')), true);
});

test('agent refresh skips safe confirmations and records a failing adapter without stopping', async (t) => {
  const f = await fixture(t);
  const suffix = `${process.pid}-${Date.now()}`;
  const safe = `ba90-safe-${suffix}`;
  const broken = `ba90-broken-${suffix}`;
  const adapters = await mkdtemp(join(tmpdir(), 'ba90-adapters-'));
  t.after(() => rm(adapters, { recursive: true, force: true }));
  const safeDir = join(adapters, safe);
  const brokenDir = join(adapters, broken);
  const marker = join(f.home, '.ba90-safe-applied');
  f.env.BRAINATLAS_TEST_ADAPTERS = '1';
  f.env.BRAINATLAS_ADAPTER_ROOT = adapters;
  const writeConfig = async (agents) => {
    await mkdir(join(f.home, 'config', 'brainatlas'), { recursive: true });
    const config = defaultConfig('lite');
    config.vault.path = f.vault;
    config.agents = agents;
    await writeFile(f.paths.configFile, `${JSON.stringify(config, null, 2)}\n`);
  };
  await mkdir(join(safeDir, 'src'), { recursive: true });
  await writeFile(
    join(safeDir, 'src', 'index.mjs'),
    `// SPDX-License-Identifier: MIT
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
export async function doctor() { return { ok: true }; }
export async function plan(ctx) {
  return {
    changes: [{ file: join(ctx.env.HOME, '.ba90-safe-applied'), before: null, after: 'applied\\n', kind: 'create' }],
    warnings: ['needs confirmation'],
    needsConfirmation: true,
  };
}
export async function apply(changes) {
  for (const change of changes.changes) await writeFile(change.file, change.after);
}
`
  );
  await mkdir(join(brokenDir, 'src'), { recursive: true });
  await writeFile(
    join(brokenDir, 'src', 'index.mjs'),
    `// SPDX-License-Identifier: MIT
export async function plan() {
  throw Object.assign(new Error('boom'), { code: 'E_CHANNEL_SWITCH' });
}
`
  );
  await symlink(resolve('packages/adapters/kiro'), join(adapters, 'kiro'), 'dir');
  try {
    await writeConfig([safe]);
    const safeResult = f.ok('agent', 'refresh', '--safe');
    assert.deepEqual(safeResult.agents, []);
    assert.deepEqual(safeResult.skipped, [{ agent: safe, warnings: ['needs confirmation'] }]);
    assert.equal(await exists(marker), false);

    await writeConfig([broken, 'kiro']);
    const result = f.ok('agent', 'refresh');
    assert.equal(result.agents.length, 2);
    assert.deepEqual(result.agents[0].warnings, ['E_CHANNEL_SWITCH: boom']);
    assert.ok(result.agents[1].changed.some((file) => file.endsWith('.kiro/settings/mcp.json')));
  } finally {
    await rm(safeDir, { recursive: true, force: true });
    await rm(brokenDir, { recursive: true, force: true });
  }
});

test('install-backups is private on creation and is tightened when reused', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.home, 'CLAUDE.md'), 'user notes\n');
  f.ok('init', '--yes', '--vault', f.vault, '--agents', 'claude-code');
  const backups = join(f.paths.dataDir, 'install-backups');
  assert.equal((await lstat(backups)).mode & 0o777, 0o700);
  await chmod(backups, 0o755);
  await mkdir(join(f.home, '.kiro', 'settings'), { recursive: true });
  await writeFile(join(f.home, '.kiro', 'settings', 'mcp.json'), '{\n  "user": true\n}\n');
  f.ok('agent', 'add', 'kiro');
  assert.equal((await lstat(backups)).mode & 0o777, 0o700);
});
