// SPDX-License-Identifier: MIT
// BA-07 acceptance (independent): prompt hook with the semantic step, offline.
// No test here reaches an embedding provider: each case ends before an embedding request (no index, corrupt index,
// Lite, opt-out), or only checks module loading through a loader trace.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolvePaths } from '../../../packages/core/src/paths/index.mjs';
import { SEMANTIC_DEFAULTS } from '../../../packages/core/src/config/index.mjs';
import { runHook, buildHookCommand } from '../../../packages/hooks/src/index.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SUPPORT = fileURLToPath(new URL('./support/', import.meta.url));
const MARKER = 'zqprivatemarker';
const PROMPT = `${MARKER} how do gardens get soil care every spring`;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ba07-hook-'));
  const vault = join(root, 'vault');
  const home = join(root, 'home');
  mkdirSync(join(vault, 'wiki'), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(vault, 'wiki', 'alpha.md'), '# Alpha\n\nGardens and soil care for gardens every spring.\n');
  writeFileSync(join(vault, 'wiki', 'beta.md'), '# Beta\n\nRivers and bridges need inspection.\n');
  const stateDir = join(root, 'hook-state');
  const semanticDir = join(resolvePaths({ env: { HOME: home } }).stateDir, 'semantic');
  return { root, vault, home, stateDir, semanticDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function config(f, { profile = 'full', enabled = true } = {}) {
  return {
    profile, modules: profile === 'lite' ? [] : ['*'], vault: { path: f.vault }, stateDir: f.stateDir,
    hooks: { mode: 'normal', deadlineMs: 1000 }, retrieval: { abstainThreshold: 0.35 },
    semantic: { ...SEMANTIC_DEFAULTS, enabled },
  };
}

async function hook(f, cfg, prompt = PROMPT, session = `ba07-${Math.random()}`) {
  const { stdout } = await runHook({ client: 'claude', event: 'prompt', stdin: JSON.stringify({ session_id: session, prompt }), env: { HOME: f.home }, config: cfg, now: new Date() });
  return stdout;
}

function metricLines(f) {
  const file = join(f.stateDir, 'metrics', 'hooks.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
}

test('no semantic index: output equals the semantic-off output and the metric records the fallback', async () => {
  const f = fixture();
  try {
    const off = await hook(f, config(f, { enabled: false }));
    const on = await hook(f, config(f));
    assert.equal(on, off, 'BM25 output is byte-identical');
    const last = metricLines(f).at(-1);
    assert.equal(last.semantic, 'fallback:index-missing');
    assert.doesNotMatch(JSON.stringify(last), new RegExp(MARKER), 'metric line carries no prompt text');
    assert.doesNotMatch(JSON.stringify(last), /Gardens and soil/u, 'metric line carries no page text');
  } finally { f.cleanup(); }
});

test('a corrupt or truncated semantic index does not crash the hook and keeps the BM25 output', async () => {
  const f = fixture();
  try {
    const off = await hook(f, config(f, { enabled: false }));
    mkdirSync(f.semanticDir, { recursive: true, mode: 0o700 });
    for (const garbage of ['{"version":1,"dims":2,"entries":[', 'not json at all', '[]', '{"version":1,"dims":"x","entries":null}']) {
      writeFileSync(join(f.semanticDir, 'index.json'), garbage);
      const on = await hook(f, config(f));
      assert.equal(on, off, `output unchanged for ${garbage.slice(0, 20)}`);
      assert.notEqual(metricLines(f).at(-1).semantic, 'used');
    }
  } finally { f.cleanup(); }
});

test('Lite profile output equals the semantic-off output, even with the opt-in set', async () => {
  const f = fixture();
  try {
    const off = await hook(f, config(f, { enabled: false }));
    const lite = await hook(f, config(f, { profile: 'lite', enabled: true }));
    assert.equal(lite, off);
    assert.equal(metricLines(f).at(-1).semantic, undefined, 'no semantic field under Lite');
  } finally { f.cleanup(); }
});

function traceRun(f, { profile, semanticEnabled }) {
  const trace = join(f.root, `trace-${profile}-${semanticEnabled}.txt`);
  const request = JSON.stringify({ repo: ROOT, vault: f.vault, stateDir: f.stateDir, home: f.home, profile, semanticEnabled, prompt: PROMPT });
  const register = pathToFileURL(join(SUPPORT, 'trace-register.mjs')).href;
  const out = execFileSync(process.execPath, ['--import', register, join(SUPPORT, 'run-hook-child.mjs'), request], {
    env: { BA07_TRACE: trace, HOME: f.home, PATH: process.env.PATH ?? '' }, encoding: 'utf8',
  });
  const loaded = existsSync(trace) ? readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean) : [];
  return { loaded, out };
}

test('the semantic module is loaded only when requested (loader trace, with a positive control)', async () => {
  const f = fixture();
  try {
    const requested = traceRun(f, { profile: 'full', semanticEnabled: true });
    assert.ok(requested.loaded.some(url => /modules\/semantic\/src\/index\.mjs$/u.test(url)), 'positive control: module loads when requested');
    const lite = traceRun(f, { profile: 'lite', semanticEnabled: true });
    assert.deepEqual(lite.loaded, [], 'Lite never loads the semantic module');
    const off = traceRun(f, { profile: 'full', semanticEnabled: false });
    assert.deepEqual(off.loaded, [], 'opt-out never loads the semantic module');
    assert.equal(lite.out, off.out, 'Lite and opt-out produce the same hook output');
  } finally { f.cleanup(); }
});

test('hook sources never statically import the semantic module (single- and multi-line forms)', () => {
  const dir = join(ROOT, 'packages/hooks/src');
  const staticImport = /(^|[\s;])(?:import|export)\s*(?:type\s+)?(?:[^;'"`]*?\bfrom\s*)?['"`][^'"`]*modules\/[^'"`]*['"`]/mu;
  for (const name of readdirSync(dir).filter(n => n.endsWith('.mjs'))) {
    const source = readFileSync(join(dir, name), 'utf8');
    assert.doesNotMatch(source, staticImport, name);
  }
  // Dynamic import is the one permitted form; make sure it exists so the check is not vacuous.
  assert.match(readFileSync(join(dir, 'semantic.mjs'), 'utf8'), /'modules',\s*'semantic'/u, 'the dynamic entry is built from the release root');
  // The regex must catch the forms it is meant to catch (sanity check of the check itself).
  for (const bad of ["import x from '../../../modules/semantic/src/index.mjs';", "import {\n  a,\n  b\n} from '../../modules/semantic/src/hybrid.mjs';", "export * from '../modules/semantic/src/index.mjs';", "import '../../modules/semantic/src/index.mjs';"]) assert.match(bad, staticImport, bad);
  assert.doesNotMatch("const m = await import('../../../modules/semantic/src/index.mjs');", staticImport);
});

test('buildHookCommand grants read-only access to the semantic index directory', () => {
  const f = fixture();
  const previous = process.env.HOME;
  try {
    process.env.HOME = f.home;
    const paths = { vault: f.vault, state: resolvePaths({ env: { HOME: f.home } }).stateDir, release: ROOT, configFile: join(f.home, 'config.json') };
    const args = buildHookCommand({ nodePath: process.execPath, shimPath: join(ROOT, 'packages/hooks/bin/brainatlas-hook.mjs'), client: 'claude', event: 'prompt', paths });
    if (!args.includes('--permission')) return; // Node without the permission model: nothing to grant.
    assert.ok(args.includes(`--allow-fs-read=${f.semanticDir}`), 'semantic index directory is readable');
    assert.ok(!args.includes(`--allow-fs-write=${f.semanticDir}`), 'semantic index directory is not writable');
    assert.ok(!args.some(a => a.startsWith('--allow-fs-write=') && a.includes('/semantic')), 'no write grant under semantic/');
  } finally {
    if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous;
    f.cleanup();
  }
});

test('lexical output matches the main checkout (skipped unless this worktree is on track/BA-07)', async t => {
  const branch = execFileSync('git', ['-C', ROOT, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();
  if (branch !== 'track/BA-07') { t.skip(`branch is ${branch}`); return; }
  const common = execFileSync('git', ['-C', ROOT, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim();
  const mainRoot = dirname(common);
  const mainHook = join(mainRoot, 'packages/hooks/src/index.mjs');
  if (!existsSync(mainHook)) { t.skip('main checkout not found'); return; }
  const { runHook: mainRunHook } = await import(mainHook);
  const f = fixture();
  try {
    for (const [i, prompt] of [PROMPT, 'bridges inspection', 'what about rivers?'].entries()) {
      // One fresh session per prompt and pair: per-session dedup must not make the two outputs diverge.
      const cfg = config(f, { enabled: false });
      const mine = await hook(f, cfg, prompt, `ba07-cmp-mine-${i}`);
      const { stdout: theirs } = await mainRunHook({ client: 'claude', event: 'prompt', stdin: JSON.stringify({ session_id: `ba07-cmp-main-${i}`, prompt }), env: { HOME: f.home }, config: cfg, now: new Date() });
      assert.equal(mine, theirs, `identical lexical output for "${prompt}"`);
    }
  } finally { f.cleanup(); }
});
