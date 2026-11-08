// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, lstat, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { defaultConfig, resolvePaths, vaultId } from '../../packages/core/src/index.mjs';
import { hookCommandFor, main } from '../../packages/cli/src/index.mjs';
import { cleanEnv } from './clean-env.mjs';

test('init, config, plan and doctor use an isolated HOME', async t => {
  const home = await mkdtemp(join(tmpdir(), 'ba-cli-')); t.after(() => rm(home, { recursive: true, force: true }));
  const env = cleanEnv({ HOME: home, XDG_CONFIG_HOME: join(home, 'config'), XDG_DATA_HOME: join(home, 'data'), XDG_STATE_HOME: join(home, 'state'), BRAINATLAS_PLATFORM: 'linux', BRAINATLAS_OFFLINE: '1' });
  const run = (...args) => spawnSync(process.execPath, [resolve('packages/cli/bin/brainatlas.mjs'), ...args], { env, encoding: 'utf8', shell: false });
  const initHelp = run('help', 'init');
  assert.equal(initHelp.status, 0, initHelp.stderr);
  assert.match(initHelp.stdout, /--agents claude-code,copilot-vscode,kiro,codex,gemini-cli/);
  assert.match(initHelp.stdout, /--plan.*--json/);
  const syncHelp = run('help', 'sync');
  assert.equal(syncHelp.status, 0, syncHelp.stderr);
  assert.match(syncHelp.stdout, /sync is provided by the Full profile modules; install\/enable sync-engine/);
  assert.equal(run('init', '--yes', '--vault', join(home, 'vault')).status, 0);
  const initPlan = run('init', '--yes', '--vault', join(home, 'planned-vault'), '--plan', '--json');
  assert.equal(initPlan.status, 0, initPlan.stderr); assert.ok(initPlan.stdout.includes('~/config/brainatlas/config.json')); assert.ok(!initPlan.stdout.includes(home));
  const file = join(home, 'config', 'brainatlas', 'config.json'); const before = await readFile(file, 'utf8');
  assert.equal(run('config', 'set', 'hooks.deadlineMs', '1234', '--plan').status, 0);
  assert.equal(await readFile(file, 'utf8'), before);
  assert.equal(run('config', 'set', 'hooks.deadlineMs', '1234').status, 0);
  assert.equal(JSON.parse(run('config', 'get', 'hooks.deadlineMs', '--json').stdout), 1234);
  const username = ['ba', 'cli', randomBytes(5).toString('hex')].join('-');
  const token = ['ba', 'cli', randomBytes(24).toString('hex')].join('-');
  const remote = `https://${username}:${token}@example.com/repo`;
  const configured = run('config', 'set', 'sync.options.remote', remote, '--json');
  assert.equal(configured.status, 0); assert.ok(JSON.parse(configured.stdout).warnings.length); assert.ok(!configured.stdout.includes(token)); assert.ok(!configured.stderr.includes(token)); assert.ok(!configured.stdout.includes(username)); assert.ok(!configured.stderr.includes(username));
  const remoteValue = run('config', 'get', 'sync.options.remote', '--json');
  assert.equal(remoteValue.status, 0); assert.ok(!remoteValue.stdout.includes(token)); assert.ok(!remoteValue.stdout.includes(username));
  assert.equal(run('config', 'set', 'safety.secretFilter', 'false').status, 1);
  const status = run('status', '--json'); assert.equal(status.status, 0); assert.equal(JSON.parse(status.stdout).checks.config, true);
  assert.equal(run('doctor', '--json').status, 1);
  assert.deepEqual(JSON.parse(run('update', '--check', '--metadata-only', '--json').stdout), { status: 'unknown', reason: 'offline' });
  const unavailable = run('init', '--yes', '--agents', 'missing-adapter', '--json');
  assert.equal(unavailable.status, 0);
  assert.match(JSON.parse(unavailable.stdout).warnings[0], /unavailable/);
  const evaluation = run('eval', '--json');
  assert.equal(evaluation.status, 0, evaluation.stderr);
  assert.ok(JSON.parse(evaluation.stdout).n > 0);
  const hook = spawnSync(process.execPath, [resolve('packages/cli/bin/brainatlas.mjs'), 'hook', 'codex', 'prompt'], { env, encoding: 'utf8', input: '{}', shell: false });
  assert.equal(hook.status, 0, hook.stderr); assert.deepEqual(JSON.parse(hook.stdout), {});
  assert.equal(JSON.parse(run('config', 'get', 'vault.path', '--json').stdout), join(home, 'BrainAtlas'));
  await mkdir(join(home, 'BrainAtlas', 'wiki'), { recursive: true });
  await lstat(join(home, 'BrainAtlas', 'wiki'));
  const mcp = spawnSync(process.execPath, [resolve('packages/cli/bin/brainatlas.mjs'), 'mcp'], { env: cleanEnv({ ...env, BRAINATLAS_VAULT: join(home, 'BrainAtlas') }), encoding: 'utf8', input: '', timeout: 5000, shell: false });
  assert.equal(mcp.status, 0, mcp.stderr);
  const state = join(home, 'state', 'brainatlas');
  await lstat(state);
  const paths = resolvePaths({ platform: 'linux', env }); const config = defaultConfig('lite'); config.vault.path = join(home, 'vault');
  const hookCommand = await hookCommandFor({ client: 'codex', event: 'prompt', paths, config });
  assert.deepEqual(hookCommand.slice(-3), [paths.binPath, 'codex', 'prompt']);
  await lstat(join(paths.stateDir, vaultId(config.vault.path)));
});

test('metadata checks skip fetch offline and use the injected fetch online', async t => {
  const home = await mkdtemp(join(tmpdir(), 'ba-fetch-')); t.after(() => rm(home, { recursive: true, force: true }));
  const base = cleanEnv({ HOME: home, XDG_CONFIG_HOME: join(home, 'config'), XDG_DATA_HOME: join(home, 'data'), XDG_STATE_HOME: join(home, 'state'), BRAINATLAS_PLATFORM: 'linux', BRAINATLAS_UPDATE_METADATA_URL: 'https://example.com/metadata' });
  let calls = 0; const fetch = async () => { calls += 1; return { ok: true, json: async () => ({ version: '1.2.3' }) }; };
  const original = console.log; const lines = []; console.log = value => lines.push(value);
  try {
    await main(['update', '--check', '--json'], { ...base, BRAINATLAS_OFFLINE: '1' }, { fetch });
    assert.equal(calls, 0); assert.equal(JSON.parse(lines.pop()).reason, 'offline');
    await main(['update', '--check', '--json'], { ...base, BRAINATLAS_OFFLINE: '0' }, { fetch });
    assert.equal(calls, 1); assert.equal(JSON.parse(lines.pop()).offeredVersion, '1.2.3');
  } finally { console.log = original; }
});
