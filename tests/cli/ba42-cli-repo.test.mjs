// SPDX-License-Identifier: MIT
// BA-42: `brainatlas maintain --repo DIR` argument handling and output, through the real CLI entry point.
// Hermetic: temporary vault, repository and HOME directories only; no network, no git.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { cleanEnv } from './clean-env.mjs';

const BIN = resolve('packages/cli/bin/brainatlas.mjs');
const page = (sources, symbols) => `---\ntype: concept\ngenerated: "2026-11-01"\nstatus: proposed\nsources: ${JSON.stringify(sources)}\nverified: []\nstale_after: "P90D"\naliases: []\nkeywords: []\n${symbols ? `symbols: ${JSON.stringify(symbols)}\n` : ''}---\n\n# A\n\nBody text.\n`;

async function setup(t) {
  const base = await mkdtemp(join(tmpdir(), 'ba42-cli-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const vault = join(base, 'vault');
  const repo = join(base, 'repo');
  const home = join(base, 'home');
  await mkdir(join(vault, 'wiki', 'concepts'), { recursive: true });
  await mkdir(join(repo, 'src'), { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFile(join(vault, 'wiki', 'index.md'), '# Wiki Index\n\n## Pages\n\n- [A](concepts/a.md)\n');
  await writeFile(join(vault, 'wiki', 'concepts', 'a.md'), page(['repo:src/gone.mjs@abcdef1', 'repo:src/total.mjs'], [{ path: 'src/total.mjs', name: 'removedThing' }]));
  await writeFile(join(repo, 'src', 'total.mjs'), 'export function computeTotal() { return 1; }\n');
  const env = cleanEnv({ HOME: home, XDG_CONFIG_HOME: join(home, 'config'), XDG_DATA_HOME: join(home, 'data'), XDG_STATE_HOME: join(home, 'state'), BRAINATLAS_PLATFORM: 'linux', BRAINATLAS_OFFLINE: '1' });
  return { base, vault, repo, env };
}

const run = (env, args) => spawnSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8', shell: false });

test('maintain --repo --json reports stale-source and stale-symbol with repository-relative paths and exits 0', async t => {
  const { base, vault, repo, env } = await setup(t);
  const result = run(env, ['maintain', '--json', '--vault', vault, '--repo', repo]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout.includes(base), false, 'output must not contain absolute paths');
  const out = JSON.parse(result.stdout);
  assert.deepEqual(out.findings.filter(f => f.kind === 'stale-source'), [{ kind: 'stale-source', path: 'wiki/concepts/a.md', detail: 'repo file not found: src/gone.mjs' }]);
  assert.deepEqual(out.findings.filter(f => f.kind === 'stale-symbol'), [{ kind: 'stale-symbol', path: 'wiki/concepts/a.md', detail: 'symbol not found in repo file: src/total.mjs#removedThing' }]);
  assert.deepEqual(Object.keys(out.counts).sort(), ['broken-link', 'index-missing', 'index-stale', 'orphan', 'oversized', 'stale', 'superseded-broken', 'update-sprawl']);
});

test('maintain without --repo reads no repository and reports no code findings', async t => {
  const { vault, env } = await setup(t);
  const result = run(env, ['maintain', '--json', '--vault', vault]);
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.equal(out.findings.some(f => f.kind === 'stale-source' || f.kind === 'stale-symbol'), false);
});

test('human maintain output lists the code findings under their own headings', async t => {
  const { vault, repo, env } = await setup(t);
  const result = run(env, ['maintain', '--vault', vault, '--repo', repo]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /stale-source \(1\)/u);
  assert.match(result.stdout, /stale-symbol \(1\)/u);
});

test('--repo pointing at a missing directory fails with E_REPO_MISSING and no path in the message', async t => {
  const { base, vault, env } = await setup(t);
  const result = run(env, ['maintain', '--json', '--vault', vault, '--repo', join(base, 'absent')]);
  assert.equal(result.status, 1);
  const out = JSON.parse(result.stdout);
  assert.equal(out.ok, false);
  assert.equal(out.error.code, 'E_REPO_MISSING');
  assert.equal(result.stdout.includes(base), false);
});

test('--repo without a value is an argument error', async t => {
  const { vault, env } = await setup(t);
  const result = run(env, ['maintain', '--vault', vault, '--repo']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /E_ARGUMENT/u);
});

test('help for maintain shows the --repo DIR option', async t => {
  const { env } = await setup(t);
  const result = run(env, ['help', 'maintain']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /brainatlas maintain \[--json\] \[--vault PATH\] \[--queue\] \[--repo DIR\]/u);
});
