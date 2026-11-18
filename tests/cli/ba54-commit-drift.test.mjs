// SPDX-License-Identifier: MIT
// BA-54: `maintain --repo` verifies the `@<commit>` suffix of `repo:` sources with read-only git and reports
// unknown-commit, source-drift and unverifiable. Hermetic: temporary vaults and git repositories only, no network, and
// maintain never writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  FINDING_KINDS,
  KINDS,
  formatMaintenance,
  receiptCandidates,
  runMaintenance,
} from '../../packages/cli/src/maintain.mjs';
import { cleanEnv } from './clean-env.mjs';

const BIN = resolve('packages/cli/bin/brainatlas.mjs');
const NOW = new Date('2026-11-11T00:00:00Z');
const SOURCE_FILE = 'export function computeTotal(items) {\n  return items.length;\n}\n';
const COMMIT_KINDS = ['unknown-commit', 'source-drift', 'unverifiable'];
const GIT_CONFIG = ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false'];
const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };

const git = (cwd, args) =>
  execFileSync('git', [...GIT_CONFIG, ...args], {
    cwd,
    encoding: 'utf8',
    env: gitEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
const head = (cwd) => git(cwd, ['rev-parse', 'HEAD']).trim();

const page = ({ title = 'A', sources = [], symbols } = {}) => {
  const lines = [
    '---',
    'type: concept',
    'generated: "2026-11-01"',
    'status: proposed',
    `sources: ${JSON.stringify(sources)}`,
    'verified: []',
    'stale_after: "P90D"',
    'aliases: []',
    'keywords: []',
  ];
  if (symbols !== undefined) lines.push(`symbols: ${JSON.stringify(symbols)}`);
  return `${lines.join('\n')}\n---\n\n# ${title}\n\nBody text.\n`;
};
const INDEX = '# Wiki Index\n\n## Pages\n\n- [A](concepts/a.md)\n';
const commitFindings = (report) => report.findings.filter((item) => COMMIT_KINDS.includes(item.kind));

async function writeTree(root, files) {
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, rel)), { recursive: true });
    await writeFile(join(root, rel), text);
  }
}

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'ba54-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  return { base, vault: join(base, 'vault'), repo: join(base, 'repo') };
}

async function vaultAt(dir, sources, symbols) {
  await writeTree(dir, { 'wiki/index.md': INDEX, 'wiki/concepts/a.md': page({ sources, symbols }) });
  return dir;
}

const commitAll = (dir, message) => {
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', message]);
  return head(dir);
};

/** A repository with one committed source file; returns its commit. */
async function seededRepo(dir) {
  await mkdir(dir, { recursive: true });
  git(dir, ['init', '-q']);
  await writeTree(dir, { 'src/total.mjs': SOURCE_FILE });
  return commitAll(dir, 'seed');
}

// ---- Commit existence and drift.

test('a commit-bearing source whose file is unchanged since that commit reports nothing', async (t) => {
  const { vault, repo } = await fixture(t);
  const commit = await seededRepo(repo);
  await vaultAt(vault, [`repo:src/total.mjs@${commit}`]);
  const report = await runMaintenance(vault, { now: NOW, repo });
  assert.deepEqual(commitFindings(report), []);
  assert.deepEqual(
    report.findings.filter((item) => item.kind === 'stale-source'),
    []
  );
});

test('an upper-case commit suffix is accepted and compared lower-cased', async (t) => {
  const { vault, repo } = await fixture(t);
  const commit = await seededRepo(repo);
  await vaultAt(vault, [`repo:src/total.mjs@${commit.toUpperCase()}`]);
  assert.deepEqual(commitFindings(await runMaintenance(vault, { now: NOW, repo })), []);
});

test('a file changed in a later commit reports source-drift with the short commit and path', async (t) => {
  const { vault, repo } = await fixture(t);
  const first = await seededRepo(repo);
  await writeTree(repo, { 'src/total.mjs': `${SOURCE_FILE}export const VERSION_TAG = 2;\n` });
  commitAll(repo, 'change');
  await vaultAt(vault, [`repo:src/total.mjs@${first}`]);
  assert.deepEqual(commitFindings(await runMaintenance(vault, { now: NOW, repo })), [
    {
      kind: 'source-drift',
      path: 'wiki/concepts/a.md',
      detail: `changed since ${first.slice(0, 7)}: src/total.mjs`,
    },
  ]);
});

test('an uncommitted working-tree change alone is not drift (only the commit and HEAD are compared)', async (t) => {
  const { vault, repo } = await fixture(t);
  const commit = await seededRepo(repo);
  await writeTree(repo, { 'src/total.mjs': `${SOURCE_FILE}// uncommitted\n` });
  await vaultAt(vault, [`repo:src/total.mjs@${commit}`]);
  assert.deepEqual(commitFindings(await runMaintenance(vault, { now: NOW, repo })), []);
});

test('a commit that is not in the repository reports unknown-commit', async (t) => {
  const { vault, repo } = await fixture(t);
  await seededRepo(repo);
  await vaultAt(vault, ['repo:src/total.mjs@deadbeef']);
  assert.deepEqual(commitFindings(await runMaintenance(vault, { now: NOW, repo })), [
    { kind: 'unknown-commit', path: 'wiki/concepts/a.md', detail: 'commit not found: deadbee' },
  ]);
});

test('one unknown commit used for two paths on one page is reported once', async (t) => {
  const { vault, repo } = await fixture(t);
  await seededRepo(repo);
  await writeTree(repo, { 'src/other.mjs': SOURCE_FILE });
  await vaultAt(vault, ['repo:src/total.mjs@deadbeef', 'repo:src/gone.mjs@deadbeef']);
  const report = await runMaintenance(vault, { now: NOW, repo });
  assert.deepEqual(
    report.findings.filter((item) => item.kind === 'unknown-commit'),
    [{ kind: 'unknown-commit', path: 'wiki/concepts/a.md', detail: 'commit not found: deadbee' }]
  );
});

// ---- unverifiable: shallow clone, non-git directory, missing HEAD.

test('a shallow clone reports unverifiable for a commit it does not contain', async (t) => {
  const { base, vault, repo } = await fixture(t);
  const first = await seededRepo(repo);
  await writeTree(repo, { 'src/total.mjs': `${SOURCE_FILE}// second\n` });
  commitAll(repo, 'second');
  git(base, ['clone', '-q', '--depth', '1', `file://${repo}`, 'shallow']);
  const clone = join(base, 'shallow');
  await vaultAt(vault, [`repo:src/total.mjs@${first}`]);
  assert.deepEqual(commitFindings(await runMaintenance(vault, { now: NOW, repo: clone })), [
    {
      kind: 'unverifiable',
      path: 'wiki/concepts/a.md',
      detail: `commit cannot be verified: ${first.slice(0, 7)}`,
    },
  ]);
  // The one commit the shallow clone does contain is still verifiable.
  await vaultAt(vault, [`repo:src/total.mjs@${head(clone)}`]);
  assert.deepEqual(commitFindings(await runMaintenance(vault, { now: NOW, repo: clone })), []);
});

test('a directory that is not a git work tree reports unverifiable', async (t) => {
  const { vault, repo } = await fixture(t);
  await writeTree(repo, { 'src/total.mjs': SOURCE_FILE });
  await vaultAt(vault, ['repo:src/total.mjs@abcdef1']);
  assert.deepEqual(commitFindings(await runMaintenance(vault, { now: NOW, repo })), [
    { kind: 'unverifiable', path: 'wiki/concepts/a.md', detail: 'commit cannot be verified: abcdef1' },
  ]);
});

test('a repository without a resolvable HEAD reports unverifiable', async (t) => {
  const { vault, repo } = await fixture(t);
  await mkdir(repo, { recursive: true });
  git(repo, ['init', '-q']);
  await writeTree(repo, { 'src/total.mjs': SOURCE_FILE });
  await vaultAt(vault, ['repo:src/total.mjs@abcdef1']);
  assert.deepEqual(commitFindings(await runMaintenance(vault, { now: NOW, repo })), [
    { kind: 'unverifiable', path: 'wiki/concepts/a.md', detail: 'commit cannot be verified: abcdef1' },
  ]);
});

// ---- Path handling around commits.

test('a source without a commit adds no commit finding, even outside a git repository', async (t) => {
  const { vault, repo } = await fixture(t);
  await writeTree(repo, { 'src/total.mjs': SOURCE_FILE });
  await vaultAt(vault, ['repo:src/total.mjs']);
  assert.deepEqual(commitFindings(await runMaintenance(vault, { now: NOW, repo })), []);
});

test('a missing path keeps only stale-source but its commit is still existence-checked', async (t) => {
  const { vault, repo } = await fixture(t);
  await seededRepo(repo);
  await vaultAt(vault, ['repo:src/gone.mjs@deadbeef']);
  const report = await runMaintenance(vault, { now: NOW, repo });
  assert.deepEqual(
    report.findings.filter((item) => item.kind === 'stale-source'),
    [{ kind: 'stale-source', path: 'wiki/concepts/a.md', detail: 'repo file not found: src/gone.mjs' }]
  );
  assert.deepEqual(commitFindings(report), [
    { kind: 'unknown-commit', path: 'wiki/concepts/a.md', detail: 'commit not found: deadbee' },
  ]);
});

test('a rejected path keeps only stale-source and does not drift-check it', async (t) => {
  const { vault, repo } = await fixture(t);
  const commit = await seededRepo(repo);
  await vaultAt(vault, [`repo:../secret.mjs@${commit}`]);
  const report = await runMaintenance(vault, { now: NOW, repo });
  assert.deepEqual(
    report.findings.filter((item) => item.kind === 'stale-source').map((item) => item.detail),
    ['repo path is not a file path inside the repository']
  );
  assert.deepEqual(commitFindings(report), []);
});

test('a file deleted in a later commit is stale-source, not source-drift', async (t) => {
  const { vault, repo } = await fixture(t);
  const first = await seededRepo(repo);
  git(repo, ['rm', '-q', 'src/total.mjs']);
  git(repo, ['commit', '-q', '-m', 'remove']);
  await vaultAt(vault, [`repo:src/total.mjs@${first}`]);
  const report = await runMaintenance(vault, { now: NOW, repo });
  assert.deepEqual(
    report.findings.filter((item) => item.kind === 'stale-source').map((item) => item.detail),
    ['repo file not found: src/total.mjs']
  );
  assert.deepEqual(commitFindings(report), []);
});

// ---- Contract: counts, human output, receipts and identical output without --repo.

test('the three new kinds are finding kinds only: counts keeps exactly the BA-12 keys', async (t) => {
  const { vault, repo } = await fixture(t);
  await seededRepo(repo);
  await vaultAt(vault, ['repo:src/total.mjs@deadbeef']);
  const withRepo = await runMaintenance(vault, { now: NOW, repo });
  const without = await runMaintenance(vault, { now: NOW });
  const expectedKeys = [
    'broken-link',
    'index-missing',
    'index-stale',
    'orphan',
    'oversized',
    'stale',
    'superseded-broken',
    'update-sprawl',
  ];
  assert.deepEqual(Object.keys(withRepo.counts).sort(), expectedKeys);
  assert.deepEqual(Object.keys(without.counts).sort(), expectedKeys);
  assert.deepEqual(KINDS.slice().sort(), expectedKeys);
  for (const kind of COMMIT_KINDS) {
    assert.ok(FINDING_KINDS.includes(kind));
    assert.equal(withRepo.counts[kind], undefined);
  }
  assert.deepEqual(FINDING_KINDS.slice(FINDING_KINDS.indexOf('stale-symbol') + 1), COMMIT_KINDS);
});

test('the human output and the receipt candidates list the new kinds by path, with no file content', async (t) => {
  const { vault, repo } = await fixture(t);
  const first = await seededRepo(repo);
  await writeTree(repo, { 'src/total.mjs': `${SOURCE_FILE}// drift\n` });
  commitAll(repo, 'change');
  await vaultAt(vault, [`repo:src/total.mjs@${first}`, 'repo:src/total.mjs@deadbeef']);
  const report = await runMaintenance(vault, { now: NOW, repo });
  const text = formatMaintenance(report);
  assert.match(text, /source-drift \(1\)/u);
  assert.match(text, /unknown-commit \(1\)/u);
  assert.match(text, new RegExp(`wiki/concepts/a\\.md: changed since ${first.slice(0, 7)}: src/total\\.mjs`, 'u'));
  assert.doesNotMatch(text, /computeTotal|items\.length|VERSION_TAG/u);
  const titles = receiptCandidates(report.findings).map((candidate) => candidate.title);
  assert.ok(titles.includes('Maintenance review: source-drift (1)'));
  assert.ok(titles.includes('Maintenance review: unknown-commit (1)'));
});

test('without --repo the JSON is byte-identical before and after the repository changes', async (t) => {
  const { base, vault, repo } = await fixture(t);
  const commit = await seededRepo(repo);
  await vaultAt(vault, [`repo:src/total.mjs@${commit}`]);
  const home = join(base, 'home');
  await mkdir(home, { recursive: true });
  const env = cleanEnv({
    HOME: home,
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_DATA_HOME: join(home, 'data'),
    XDG_STATE_HOME: join(home, 'state'),
    BRAINATLAS_PLATFORM: 'linux',
    BRAINATLAS_OFFLINE: '1',
  });
  const run = () => {
    const result = spawnSync(process.execPath, [BIN, 'maintain', '--json', '--vault', vault], {
      env,
      encoding: 'utf8',
      shell: false,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    const out = JSON.parse(result.stdout);
    const { durationMs, ...stable } = out;
    assert.equal(typeof durationMs, 'number');
    return JSON.stringify(stable);
  };
  const before = run();
  await writeTree(repo, { 'src/total.mjs': `${SOURCE_FILE}// changed\n` });
  commitAll(repo, 'change');
  await writeFile(join(repo, 'src', 'total.mjs'), '// uncommitted\n');
  assert.equal(run(), before);
  assert.equal(before.includes('unknown-commit') || before.includes('source-drift'), false);
});
