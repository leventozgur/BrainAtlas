// SPDX-License-Identifier: MIT
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const cli = join(root, 'packages/cli/bin/brainatlas.mjs');
function sandbox(t) {
  const base = mkdtempSync(join(tmpdir(), 'initcfg-blind-')); t.after(() => rmSync(base, { recursive: true, force: true }));
  const home = join(base, 'home'); mkdirSync(home);
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share'), XDG_STATE_HOME: join(home, '.local/state'), BRAINATLAS_PLATFORM: 'linux', BRAINATLAS_OFFLINE: '1' };
  return { base, home, env, file: join(home, '.config/brainatlas/config.json') };
}
function run(env, ...args) { return spawnSync(process.execPath, [cli, ...args], { cwd: root, env, encoding: 'utf8' }); }
function ok(p) { assert.equal(p.status, 0, p.stderr + p.stdout); }
function read(s) { return JSON.parse(readFileSync(s.file, 'utf8')); }
function write(s, cfg) { writeFileSync(s.file, JSON.stringify(cfg, null, 2) + '\n'); }
function seed(s) {
  ok(run(s.env, 'init', '--yes', '--vault', join(s.base, 'vault'), '--agents', 'missing-adapter'));
  const cfg = read(s); Object.assign(cfg, { modules: ['example'], retrieval: { budgetChars: 1, abstainThreshold: 1 }, hooks: { mode: 'manual', deadlineMs: 1 }, okf: { level: 'strict' }, sync: { transport: 'custom', options: { remote: 'ssh://example.invalid/path', hostId: 'host-1', nested: { enabled: true } } } }); write(s, cfg); return cfg;
}

test('real release install retains explicit vault when installed CLI initializes again', t => {
  const s = sandbox(t); const dist = join(s.base, 'dist');
  const build = spawnSync(process.execPath, [join(root, 'release/build-release.mjs'), '--version', '0.1.0', '--profile', 'lite', '--out', dist], { cwd: root, env: s.env, encoding: 'utf8' }); ok(build);
  const vault = join(s.base, 'vault with spaces');
  const install = spawnSync('sh', [join(root, 'install.sh'), '--from', join(dist, 'brainatlas-0.1.0-lite.tgz'), '--insecure-skip-signature', '--prefix-home', s.home, '--vault', vault, '--yes'], { cwd: root, env: s.env, encoding: 'utf8' }); ok(install);
  assert.equal(read(s).vault.path, vault); assert.equal(existsSync(join(s.home, 'BrainAtlas')), false);
  const installed = spawnSync(join(s.home, '.local/share/brainatlas/bin/brainatlas'), ['init', '--yes'], { cwd: root, env: s.env, encoding: 'utf8' }); ok(installed);
  assert.equal(read(s).vault.path, vault); assert.equal(existsSync(join(s.home, 'BrainAtlas')), false);
});

test('explicit agents and profile change only their respective fields', t => {
  const s = sandbox(t); const before = seed(s);
  ok(run(s.env, 'init', '--agents', 'other-adapter', '--yes'));
  const afterAgents = read(s); assert.deepEqual(afterAgents, { ...before, agents: ['other-adapter'] });
  assert.equal(JSON.stringify(afterAgents.sync), JSON.stringify(before.sync));
  ok(run(s.env, 'init', '--profile', 'full', '--yes'));
  assert.deepEqual(read(s), { ...afterAgents, profile: 'full', modules: ['*'] });
  ok(run(s.env, 'init', '--vault', join(s.base, 'new-vault'), '--yes'));
  assert.deepEqual(read(s), { ...afterAgents, profile: 'full', modules: ['*'], vault: { path: join(s.base, 'new-vault') } });
});

test('new configuration defaults and explicit profile boundary', t => {
  const s = sandbox(t); ok(run(s.env, 'init', '--yes')); const cfg = read(s);
  assert.equal(cfg.vault.path, join(s.home, 'BrainAtlas')); assert.equal(cfg.profile, 'lite'); assert.deepEqual(cfg.modules, []); assert.deepEqual(cfg.agents, []); assert.deepEqual(cfg.sync, { transport: null, options: {} }); assert.ok(existsSync(cfg.vault.path));
  const s2 = sandbox(t); ok(run(s2.env, 'init', '--yes', '--profile', 'full', '--vault', join(s2.base, 'v'))); assert.deepEqual(read(s2).modules, ['*']); assert.equal(existsSync(join(s2.home, 'BrainAtlas')), false);
});

test('plan reports changes without writes or leaking a synthetic secret', t => {
  const s = sandbox(t); const cfg = seed(s); const secret = ['sk', 'test' + 'x'.repeat(24)].join('-'); cfg.sync.options.remote = secret; write(s, cfg);
  const before = readFileSync(s.file, 'utf8'); const p = run(s.env, 'init', '--profile', 'full', '--plan', '--json'); ok(p);
  const plan = JSON.parse(p.stdout); assert.deepEqual(Object.keys(plan.config.changes).sort(), ['modules', 'profile']); assert.equal(p.stdout.includes(secret) || p.stderr.includes(secret), false); assert.equal(readFileSync(s.file, 'utf8'), before);
  const noChange = run(s.env, 'init', '--plan', '--json'); ok(noChange); assert.deepEqual(JSON.parse(noChange.stdout).config.changes, {});
});

test('invalid flags, traversal adapter and corrupt config fail without overwriting config', t => {
  const s = sandbox(t); seed(s); const before = readFileSync(s.file, 'utf8');
  for (const args of [['--profile', 'bogus'], ['--agents', '../escape'], ['--vault'], ['--profile']]) {
    const p = run(s.env, 'init', '--yes', ...args); assert.notEqual(p.status, 0, args.join(' ')); assert.equal(readFileSync(s.file, 'utf8'), before);
  }
  const secret = ['sk', 'test' + 'y'.repeat(24)].join('-'); const malformed = '{"value":"' + secret; writeFileSync(s.file, malformed);
  const p = run(s.env, 'init', '--yes'); assert.notEqual(p.status, 0); assert.equal(readFileSync(s.file, 'utf8'), malformed); assert.equal((p.stdout + p.stderr).includes(secret), false);
});

test('a symlinked malformed config is rejected without changing its target', t => {
  const s = sandbox(t); const outside = join(s.base, 'outside'); writeFileSync(outside, '{broken'); mkdirSync(resolve(s.file, '..'), { recursive: true }); symlinkSync(outside, s.file);
  const p = run(s.env, 'init', '--yes'); assert.notEqual(p.status, 0); assert.equal(readFileSync(outside, 'utf8'), '{broken'); assert.equal(existsSync(join(s.home, 'BrainAtlas')), false);
});
