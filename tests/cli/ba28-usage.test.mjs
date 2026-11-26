// SPDX-License-Identifier: MIT
// BA-28: `brainatlas usage` aggregates content-free hook metrics, and `usage feedback` appends one word.
import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { defaultConfig, resolvePaths, vaultId } from '../../packages/core/src/index.mjs';
import { cleanEnv } from './clean-env.mjs';

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'ba28-usage-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = cleanEnv({
    HOME: home,
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_DATA_HOME: join(home, 'data'),
    XDG_STATE_HOME: join(home, 'state'),
    BRAINATLAS_PLATFORM: 'linux',
    BRAINATLAS_OFFLINE: '1',
  });
  const vault = join(home, 'vault');
  await mkdir(vault);
  const paths = resolvePaths({ platform: 'linux', env });
  const config = defaultConfig('lite');
  config.vault.path = vault;
  await mkdir(dirname(paths.configFile), { recursive: true });
  await writeFile(paths.configFile, JSON.stringify(config));
  const stateDir = join(paths.stateDir, vaultId(vault));
  const metrics = join(stateDir, 'metrics');
  const run = (...args) =>
    spawnSync(process.execPath, [resolve('packages/cli/bin/brainatlas.mjs'), ...args], {
      env,
      encoding: 'utf8',
      shell: false,
    });
  return { home, env, vault, stateDir, metrics, run };
}

const emptySummary = (stateDir) => ({
  days: 7,
  stateDir,
  prompts: 0,
  events: { prompt: 0, 'session-start': 0 },
  byClient: {},
  outcomes: { ok: 0, empty: 0, deadline: 0, error: 0 },
  injectionRate: 0,
  meanResults: 0,
  durationMs: { p50: 0, p95: 0 },
  meanChars: 0,
  shadow: { n: 0, top1SameRate: 0, meanOverlap5: 0, injectDiffRate: 0 },
  feedback: { useful: 0, notUseful: 0 },
});

test('usage with no metric files reports zero records', async (t) => {
  const f = await fixture(t);
  const result = f.run('usage', '--json');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), emptySummary(f.stateDir));
  const text = f.run('usage');
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /Prompts: 0/);
  assert.match(text.stdout, /Events: prompt 0, session-start 0/);
  assert.ok(text.stdout.includes(`Metrics: ${join(f.stateDir, 'metrics', 'hooks.jsonl')}`));
});

test('usage filters by days and aggregates prompt, shadow and feedback records exactly', async (t) => {
  const f = await fixture(t);
  await mkdir(f.metrics, { recursive: true });
  const now = Date.now();
  const ts = (daysAgo) => new Date(now - daysAgo * 24 * 60 * 60 * 1000).toISOString();
  const hooks = [
    {
      ts: ts(1),
      event: 'prompt',
      outcome: 'ok',
      results: 2,
      chars: 100,
      durationMs: 10,
      shadow: { top1Same: true, overlap5: 3, injectDiff: false },
    },
    {
      ts: ts(1),
      event: 'prompt',
      outcome: 'empty',
      results: 0,
      chars: 0,
      durationMs: 20,
      shadow: { top1Same: false, overlap5: 1, injectDiff: true },
    },
    { ts: ts(2), event: 'prompt', outcome: 'deadline', results: 1, chars: 50, durationMs: 30 },
    { ts: ts(3), event: 'prompt', outcome: 'error', results: 5, chars: 250, durationMs: 40 },
    { ts: ts(4), event: 'prompt', outcome: 'ok', results: 0, chars: 0, durationMs: 50 },
    { ts: ts(1), event: 'session-start', outcome: 'ok', results: 9, chars: 999, durationMs: 60 },
    { ts: ts(10), event: 'prompt', outcome: 'ok', results: 9, chars: 999, durationMs: 70 },
  ];
  const feedback = [
    { ts: ts(1), verdict: 'useful' },
    { ts: ts(2), verdict: 'not-useful' },
    { ts: ts(2), verdict: 'maybe' },
    { ts: ts(10), verdict: 'useful' },
  ];
  await writeFile(
    join(f.metrics, 'hooks.jsonl'),
    `${hooks.map((record) => JSON.stringify(record)).join('\n')}\nnot-json\n`
  );
  await writeFile(
    join(f.metrics, 'feedback.jsonl'),
    `${feedback.map((record) => JSON.stringify(record)).join('\n')}\n`
  );
  const result = f.run('usage', '--days', '7', '--json');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    days: 7,
    stateDir: f.stateDir,
    prompts: 5,
    events: { prompt: 5, 'session-start': 1 },
    byClient: {},
    outcomes: { ok: 2, empty: 1, deadline: 1, error: 1 },
    injectionRate: 0.6,
    meanResults: 1.6,
    durationMs: { p50: 30, p95: 50 },
    meanChars: 80,
    shadow: { n: 2, top1SameRate: 0.5, meanOverlap5: 2, injectDiffRate: 0.5 },
    feedback: { useful: 1, notUseful: 1 },
  });
  assert.doesNotMatch(result.stdout, /not-json/);
});

test('usage rejects invalid day counts with E_ARGUMENT', async (t) => {
  const f = await fixture(t);
  for (const value of ['0', '-1', '1.5', 'nope', '']) {
    const result = f.run('usage', '--days', value, '--json');
    assert.equal(result.status, 1, value);
    assert.equal(JSON.parse(result.stdout).error.code, 'E_ARGUMENT', value);
  }
});

test('usage feedback writes one private line and refuses any other word', async (t) => {
  const f = await fixture(t);
  const refused = f.run('usage', 'feedback', 'maybe', '--json');
  assert.equal(refused.status, 1);
  assert.equal(JSON.parse(refused.stdout).error.code, 'E_ARGUMENT');
  const missing = await lstat(join(f.metrics, 'feedback.jsonl')).catch((error) => error.code);
  assert.equal(missing, 'ENOENT');

  const useful = f.run('usage', 'feedback', 'useful', '--json');
  assert.equal(useful.status, 0, useful.stderr);
  assert.deepEqual(JSON.parse(useful.stdout), { recorded: true, verdict: 'useful' });
  const notUseful = f.run('usage', 'feedback', 'not-useful');
  assert.equal(notUseful.status, 0, notUseful.stderr);
  assert.match(notUseful.stdout, /not-useful/);
  const file = join(f.metrics, 'feedback.jsonl');
  assert.equal((await lstat(file)).mode & 0o777, 0o600);
  const records = (await readFile(file, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(
    records.map((record) => record.verdict),
    ['useful', 'not-useful']
  );
  for (const record of records) {
    assert.deepEqual(Object.keys(record).sort(), ['ts', 'verdict']);
    assert.ok(!Number.isNaN(Date.parse(record.ts)));
  }
  const summary = f.run('usage', '--json');
  assert.equal(summary.status, 0, summary.stderr);
  assert.deepEqual(JSON.parse(summary.stdout).feedback, { useful: 1, notUseful: 1 });
});

test('usage feedback refuses a symlinked feedback file and writes nothing', async (t) => {
  const f = await fixture(t);
  await mkdir(f.metrics, { recursive: true });
  const target = join(f.home, 'outside.jsonl');
  await writeFile(target, '');
  await symlink(target, join(f.metrics, 'feedback.jsonl'));
  const result = f.run('usage', 'feedback', 'useful', '--json');
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).error.code, 'E_ARGUMENT');
  assert.equal(await readFile(target, 'utf8'), '');
});

test('usage feedback refuses a symlinked metrics directory and writes nothing', async (t) => {
  const f = await fixture(t);
  const outside = join(f.home, 'outside-metrics');
  await mkdir(outside);
  await mkdir(f.stateDir, { recursive: true });
  await symlink(outside, join(f.stateDir, 'metrics'));
  const result = f.run('usage', 'feedback', 'not-useful', '--json');
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).error.code, 'E_ARGUMENT');
  assert.deepEqual(await readdir(outside), []);
});

test('usage feedback rejects --days because it only belongs to the summary', async (t) => {
  const f = await fixture(t);
  const result = f.run('usage', 'feedback', 'useful', '--days', '3', '--json');
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).error.code, 'E_ARGUMENT');
  const missing = await lstat(join(f.metrics, 'feedback.jsonl')).catch((error) => error.code);
  assert.equal(missing, 'ENOENT');
});

test('help lists usage with its command forms', async (t) => {
  const f = await fixture(t);
  const all = f.run('--help');
  assert.equal(all.status, 0, all.stderr);
  assert.match(all.stdout, /^\s+usage\s/m);
  const detail = f.run('help', 'usage');
  assert.equal(detail.status, 0, detail.stderr);
  assert.match(
    detail.stdout,
    /brainatlas usage \[--days N\] \[--json\] \| brainatlas usage feedback useful\|not-useful/
  );
});
