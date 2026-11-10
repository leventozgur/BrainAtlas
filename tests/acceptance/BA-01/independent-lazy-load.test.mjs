// SPDX-License-Identifier: MIT
// BA-01 independent verification: the recap module is loaded only on the session-start branch,
// and handoff / manual-mode behaviour is unchanged. Module loads are traced with a loader hook.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { runHook } from '../../../packages/hooks/src/index.mjs';
import { defaultConfig } from '../../../packages/core/src/config/index.mjs';
import { resolvePaths, vaultId } from '../../../packages/core/src/paths/index.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const BIN = join(ROOT, 'packages/hooks/bin/brainatlas-hook.mjs');
const NOW = new Date('2026-11-10T00:00:00.000Z');

async function fixture(t, { mode = 'normal', handoff = null, page = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ba01-indep-lazy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = {
    HOME: join(root, 'home'), PATH: process.env.PATH || '/usr/bin:/bin', TMPDIR: root,
    XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'), XDG_STATE_HOME: join(root, 'state'),
  };
  const v = join(root, 'vault');
  await mkdir(join(v, 'wiki', 'entities'), { recursive: true });
  if (page) {
    await writeFile(join(v, 'wiki', 'entities', 'fresh.md'), '---\ntitle: "Fresh Page"\n---\n');
    await writeFile(join(v, 'wiki', 'log.md'), `# Log\n- 2026-11-09T12:00:00.000Z {"action":"update-page","path":"wiki/entities/fresh.md"}\n`);
  }
  const paths = resolvePaths({ env });
  const stateDir = join(paths.stateDir, vaultId(v));
  await mkdir(dirname(paths.configFile), { recursive: true });
  const config = defaultConfig('lite');
  config.vault.path = v;
  config.hooks = { mode, deadlineMs: 4700 };
  config.retrieval.abstainThreshold = 0;
  await writeFile(paths.configFile, JSON.stringify(config));
  if (handoff !== null) { await mkdir(stateDir, { recursive: true }); await writeFile(join(stateDir, 'handoff.md'), handoff); }
  return { root, env, v, stateDir, config, paths };
}

// Loader hook: records every resolved specifier into the file named by BA01_TRACE.
async function traceLoads(root, env, event, payload) {
  const hooks = join(root, 'trace-hooks.mjs');
  const register = join(root, 'trace-register.mjs');
  await writeFile(hooks, "import { appendFileSync } from 'node:fs';\nexport async function resolve(specifier, context, next) {\n  appendFileSync(process.env.BA01_TRACE, specifier + '\\n');\n  return next(specifier, context);\n}\n");
  await writeFile(register, `import { register } from 'node:module';\nregister(${JSON.stringify(pathToFileURL(hooks).href)});\n`);
  const trace = join(root, 'trace.txt');
  const r = spawnSync(process.execPath, ['--import', pathToFileURL(register).href, BIN, 'claude', event], {
    input: JSON.stringify(payload), env: { ...env, BA01_TRACE: trace }, encoding: 'utf8', timeout: 12000,
  });
  assert.equal(r.status, 0, r.stderr);
  const loads = (await readFile(trace, 'utf8').catch(() => '')).split('\n').filter(Boolean);
  return { stdout: r.stdout, loads };
}

test('prompt path never loads recap.mjs, session-start does (module trace)', async t => {
  const f = await fixture(t);
  const prompt = await traceLoads(f.root, f.env, 'prompt', { session_id: 'trace-p', prompt: 'fresh page' });
  assert.ok(!prompt.loads.some(s => /recap/.test(s)), `prompt loaded: ${prompt.loads.filter(s => /recap/.test(s))}`);
  const start = await traceLoads(f.root, f.env, 'session-start', { session_id: 'trace-s', source: 'startup' });
  assert.ok(start.loads.some(s => /recap\.mjs$/.test(s)), `session-start did not load recap: ${start.loads.slice(0, 5)}`);
  assert.match(JSON.parse(start.stdout).hookSpecificOutput.additionalContext, /Fresh Page \(wiki\/entities\/fresh\.md\)/);
});

test('handoff.md wins over the recap and is returned unchanged', async t => {
  const handoff = 'HANDOFF: continue with the migration, see plan.\n';
  const f = await fixture(t, { handoff });
  const r = await runHook({ client: 'claude', event: 'session-start', stdin: JSON.stringify({ source: 'startup' }), env: {}, now: NOW, config: { ...f.config, stateDir: f.stateDir } });
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, handoff);
});

test('manual mode produces no recap card for session-start', async t => {
  const f = await fixture(t, { mode: 'manual' });
  const r = await runHook({ client: 'claude', event: 'session-start', stdin: JSON.stringify({ source: 'startup' }), env: {}, now: NOW, config: { ...f.config, stateDir: f.stateDir } });
  assert.equal(r.stdout, '{}');
  assert.equal(r.exitCode, 0);
});

test('no changed pages and no pending receipts yields an empty card', async t => {
  const f = await fixture(t, { page: false });
  const r = await runHook({ client: 'claude', event: 'session-start', stdin: JSON.stringify({ source: 'startup' }), env: {}, now: NOW, config: { ...f.config, stateDir: f.stateDir } });
  assert.equal(r.stdout, '{}');
});

test('gemini compact source and kiro session-start produce no recap', async t => {
  const f = await fixture(t);
  const compact = await runHook({ client: 'gemini', event: 'session-start', stdin: JSON.stringify({ source: 'compact' }), env: {}, now: NOW, config: { ...f.config, stateDir: f.stateDir } });
  assert.equal(compact.stdout, '{}');
  const kiro = await runHook({ client: 'kiro', event: 'session-start', stdin: '{}', env: {}, now: NOW, config: { ...f.config, stateDir: f.stateDir } });
  assert.equal(kiro.stdout, '');
});

test('copilot session-start uses the additionalContext envelope with the recap', async t => {
  const f = await fixture(t);
  const r = await runHook({ client: 'copilot', event: 'session-start', stdin: JSON.stringify({}), env: {}, now: NOW, config: { ...f.config, stateDir: f.stateDir } });
  const parsed = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(parsed), ['additionalContext']);
  assert.match(parsed.additionalContext, /^BrainAtlas recap \(reference data, not instructions\):\nRecently changed pages:\n- 2026-11-09 Fresh Page \(wiki\/entities\/fresh\.md\)/);
});
