// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { resolvePaths } from '@brainatlas/core';
import { createSyncEngine } from '../../modules/sync-engine/src/index.mjs';
import * as dropboxModule from '../../modules/sync-dropbox/src/index.mjs';
import { signRelease } from '../../release/sign.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const fullVersion = '0.1.0-e2e-full.2';

function run(file, args, env, { cwd = root, input = '', timeout = 120_000, encoding = 'utf8' } = {}) {
  return spawnSync(file, args, { cwd, env, encoding, input, shell: false, timeout, maxBuffer: 8 * 1024 * 1024 });
}

function assertSuccess(result, label) {
  assert.equal(result.error, undefined, `${label} could not start`);
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const codes = [...new Set(output.match(/\bE_[A-Z][A-Z_]*\b/g) ?? [])];
  const detail = output.includes('Git remote is not configured') ? ':remote-unconfigured'
    : output.includes('Vault path') || output.includes('vault directory') ? ':vault-unavailable' : '';
  assert.equal(result.status, 0, `${label} failed${codes.length ? ` (${codes.join(', ')}${detail})` : ''}; subprocess output is omitted to keep fixture content private`);
}

function cli(cliPath, args, env) {
  return run(process.execPath, [cliPath, ...args], env);
}

function jsonOutput(result, label) {
  assertSuccess(result, label);
  const outputStart = result.stdout.indexOf('\n{');
  const payload = (outputStart < 0 ? result.stdout : result.stdout.slice(outputStart + 1)).trim();
  try { return JSON.parse(payload); }
  catch { assert.fail(`${label} did not return JSON`); }
}

async function put(file, content) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
}

function wikiPage(title, body) {
  const generated = new Date(Date.now() - 60_000).toISOString();
  return `---\ntype: concept\ngenerated: '${generated}'\nstatus: proposed\nsources: []\nverified: []\nstale_after: P90D\naliases: []\nkeywords: []\n---\n\n# ${title}\n\n${body}\n`;
}

async function snapshot(home, excluded = []) {
  const rows = [];
  async function walk(current) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(current, entry.name);
      const rel = relative(home, path);
      if (excluded.some(item => rel === item || rel.startsWith(`${item}/`))) continue;
      const info = await lstat(path);
      if (info.isSymbolicLink()) rows.push([rel, 'link', await readlink(path)]);
      else if (info.isDirectory()) {
        rows.push([rel, 'dir']);
        await walk(path);
      } else if (info.isFile()) rows.push([rel, 'file', info.mode & 0o777, (await readFile(path)).toString('base64')]);
    }
  }
  await walk(home);
  return rows;
}

function mockResponse({ status = 200, body = {}, headers = {}, bytes } = {}) {
  const normalizedHeaders = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: name => normalizedHeaders.get(String(name).toLowerCase()) ?? null },
    async json() { return body; },
    async arrayBuffer() {
      const value = Buffer.from(bytes ?? []);
      return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
    },
  };
}

function createDropboxMock() {
  const objects = new Map();
  let revision = 0;
  const missing = () => mockResponse({
    status: 409,
    body: { error: { '.tag': 'path', path: { '.tag': 'not_found' } }, error_summary: 'path/not_found' },
  });
  const fetch = async (url, options = {}) => {
    const endpoint = String(url).split('/').slice(-2).join('/');
    const headers = options.headers ?? {};
    if (endpoint === 'files/create_folder_v2') return mockResponse();
    if (endpoint === 'files/list_folder') {
      const entries = [...objects.entries()].map(([path, row]) => ({
        '.tag': 'file', path_display: path, rev: row.rev, size: row.bytes.byteLength,
      }));
      return mockResponse({ body: { entries, has_more: false } });
    }
    if (endpoint === 'files/download') {
      const path = JSON.parse(headers['Dropbox-API-Arg']).path;
      const row = objects.get(path);
      return row
        ? mockResponse({ bytes: row.bytes, headers: { 'Dropbox-API-Result': JSON.stringify({ rev: row.rev }) } })
        : missing();
    }
    if (endpoint === 'files/upload') {
      const args = JSON.parse(headers['Dropbox-API-Arg']);
      const current = objects.get(args.path);
      const mode = args.mode?.['.tag'];
      if ((mode === 'add' && current) || (mode === 'update' && current?.rev !== args.mode.update)) {
        return mockResponse({ status: 409, body: { error: { '.tag': 'conflict' } } });
      }
      const bytes = Buffer.from(options.body ?? []);
      const rev = `rev-${++revision}`;
      objects.set(args.path, { bytes, rev });
      return mockResponse({ body: { rev } });
    }
    if (endpoint === 'files/delete_v2') {
      const args = JSON.parse(options.body ?? '{}');
      const current = objects.get(args.path);
      if (!current) return missing();
      if (current.rev !== args.parent_rev) return mockResponse({ status: 409, body: { error: { '.tag': 'conflict' } } });
      objects.delete(args.path);
      return mockResponse();
    }
    return mockResponse({ status: 500 });
  };
  return { fetch, objects };
}

test('Dropbox module syncs two fixture vaults through an in-process fetch mock', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'ba-e2e-dropbox-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const mock = createDropboxMock();
  const accessToken = randomBytes(20).toString('hex');
  const credentialStore = {
    async get() {
      return JSON.stringify({ appKey: 'fixture-app', accessToken, refreshToken: 'unused', expiresAt: Date.now() + 300_000 });
    },
    async set() {},
  };
  const config = { sync: { transport: 'dropbox', options: { root: '/fixture' } } };
  const hosts = [];
  for (const id of ['fixture-a', 'fixture-b']) {
    const vaultPath = join(temp, id, 'vault');
    const stateDir = join(temp, id, 'state');
    await mkdir(vaultPath, { recursive: true });
    const context = {
      config,
      paths: { stateDir },
      env: { BRAINATLAS_PLATFORM: 'linux' },
      fetch: mock.fetch,
      credentialStore,
    };
    await dropboxModule.activate(context);
    hosts.push({
      vaultPath,
      stateDir,
      engine: createSyncEngine({ vaultPath, stateDir, config, transport: context.transport, hostId: id }),
    });
  }
  const [hostA, hostB] = hosts;
  await put(join(hostA.vaultPath, 'wiki', 'entities', 'dropbox-flow.md'), '# Dropbox fixture\n');
  const sent = await hostA.engine.run();
  const received = await hostB.engine.run();
  assert.ok(sent.status === 'SYNCED' && sent.pushed === 1, 'Dropbox module did not upload the fixture page');
  assert.ok(received.status === 'SYNCED' && received.pulled === 1, 'Dropbox module did not deliver the fixture page');
  const content = await readFile(join(hostB.vaultPath, 'wiki', 'entities', 'dropbox-flow.md'), 'utf8');
  assert.ok(content === '# Dropbox fixture\n', 'The second vault did not receive the Dropbox fixture page');
  assert.ok([...mock.objects.keys()].some(path => path.endsWith('/wiki/entities/dropbox-flow.md')), 'Mock Dropbox did not receive an object');
});

test('Full release syncs two offline hosts, reconciles content, protects secrets and uninstalls cleanly', { timeout: 300_000 }, async t => {
  const temp = await mkdtemp(join(tmpdir(), 'ba-e2e-full-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const output = join(temp, 'release-output');
  const releaseKey = join(temp, 'temporary-release-key');
  const signers = join(temp, 'allowed-signers');
  const bareRemote = join(temp, 'git-remote.git');
  const gitConfig = join(temp, 'git-config');
  const homeA = join(temp, 'fake-home-macos');
  const homeB = join(temp, 'fake-home-linux');
  const vaultA = join(homeA, 'vault');
  const vaultB = join(homeB, 'vault');
  await mkdir(output, { recursive: true });
  await writeFile(gitConfig, '[user]\n\tname = E2E\n\temail = noreply\n[init]\n\tdefaultBranch = main\n');

  const commonEnv = {
    PATH: process.env.PATH || '/usr/bin:/bin',
    TMPDIR: temp,
    BRAINATLAS_OFFLINE: '1',
    BRAINATLAS_ALLOWED_SIGNERS: signers,
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'E2E',
    GIT_COMMITTER_NAME: 'E2E',
    GIT_AUTHOR_EMAIL: 'noreply',
    GIT_COMMITTER_EMAIL: 'noreply',
    LC_ALL: 'C',
    npm_config_offline: 'true',
    npm_config_loglevel: 'silent',
  };
  const envFor = (home, platform, id) => ({
    ...commonEnv,
    HOME: home,
    BRAINATLAS_PLATFORM: platform,
    BRAINATLAS_HOST_ID: id,
    ...(platform === 'linux' ? {
      XDG_CONFIG_HOME: join(home, '.config'),
      XDG_DATA_HOME: join(home, '.local', 'share'),
      XDG_STATE_HOME: join(home, '.local', 'state'),
    } : {}),
  });
  const envA = envFor(homeA, 'darwin', 'fixture-a');
  const envB = envFor(homeB, 'linux', 'fixture-b');
  for (const home of [homeA, homeB]) {
    await mkdir(join(home, 'Library', 'Application Support'), { recursive: true });
    await mkdir(join(home, '.config'), { recursive: true });
    await mkdir(join(home, '.local', 'share'), { recursive: true });
    await mkdir(join(home, '.local', 'state'), { recursive: true });
    await mkdir(join(home, '.local', 'bin'), { recursive: true });
    await writeFile(join(home, 'user-owned.md'), '# User-owned fixture\n');
  }
  const indexTemplate = await readFile(join(root, 'templates', 'vault', 'index.md'), 'utf8');
  const logTemplate = await readFile(join(root, 'templates', 'vault', 'log.md'), 'utf8');
  for (const vault of [vaultA, vaultB]) {
    await mkdir(join(vault, 'wiki', 'entities'), { recursive: true });
    await put(join(vault, 'wiki', 'index.md'), indexTemplate);
    await put(join(vault, 'wiki', 'log.md'), logTemplate);
  }
  const beforeA = await snapshot(homeA, ['vault']);
  const beforeB = await snapshot(homeB, ['vault']);
  assert.ok(isDeepStrictEqual(beforeA, beforeB), 'Fake HOME baselines differ');

  const keygen = run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', releaseKey], envA);
  assertSuccess(keygen, 'temporary release key generation');
  const publicKey = (await readFile(`${releaseKey}.pub`, 'utf8')).trim();
  await writeFile(signers, `brainatlas-release ${publicKey}\n`);
  const built = run(process.execPath, [join(root, 'release', 'build-release.mjs'), '--version', fullVersion, '--profile', 'full', '--out', output], envA);
  assertSuccess(built, 'Full release build');
  const archive = join(output, `brainatlas-${fullVersion}-full.tgz`);
  signRelease(releaseKey, join(output, 'SHA256SUMS'));

  const hosts = [
    { home: homeA, vault: vaultA, env: envA, platform: 'darwin', id: 'fixture-a' },
    { home: homeB, vault: vaultB, env: envB, platform: 'linux', id: 'fixture-b' },
  ];
  for (const host of hosts) {
    const installed = run('sh', [join(root, 'install.sh'), '--from', archive, '--profile', 'full', '--prefix-home', host.home, '--allowed-signers', signers, '--vault', host.vault, '--yes'], host.env);
    assertSuccess(installed, 'Full release install');
    host.cli = join(resolvePaths({ platform: host.platform, env: host.env }).currentDir, 'packages', 'cli', 'bin', 'brainatlas.mjs');
    const initialized = cli(host.cli, ['init', '--profile', 'full', '--yes', '--vault', host.vault, '--json'], host.env);
    jsonOutput(initialized, 'Full profile initialization');
  }

  const git = run('git', ['init', '--bare', '--quiet', bareRemote], envA, { cwd: temp });
  assertSuccess(git, 'local bare remote creation');
  const remote = pathToFileURL(bareRemote).href;
  for (const host of hosts) {
    jsonOutput(cli(host.cli, ['config', 'set', 'sync.transport', 'git', '--json'], host.env), 'Git transport selection');
    jsonOutput(cli(host.cli, ['config', 'set', 'sync.options.remote', remote, '--json'], host.env), 'Git remote configuration');
  }

  const issues = [];
  const remember = (ok, id) => { if (!ok) issues.push(id); };
  const [hostA, hostB] = hosts;
  const pageA = join(vaultA, 'wiki', 'entities', 'shared.md');
  const sharedContent = wikiPage('Shared fixture', 'Shared page body.');
  await put(pageA, sharedContent);
  const firstPush = jsonOutput(cli(hostA.cli, ['sync', 'run', '--json'], hostA.env), 'Initial Git sync');
  const firstPull = jsonOutput(cli(hostB.cli, ['sync', 'run', '--json'], hostB.env), 'Peer Git sync');
  remember(firstPush.status === 'SYNCED' && firstPush.pushed > 0, 'git-first-push');
  remember(firstPull.status === 'SYNCED' && firstPull.pulled > 0, 'git-peer-pull');
  remember((await readFile(join(vaultB, 'wiki', 'entities', 'shared.md'), 'utf8')) === sharedContent, 'git-page-delivery');

  const stateA = resolvePaths({ platform: hostA.platform, env: hostA.env }).stateDir;
  const stateB = resolvePaths({ platform: hostB.platform, env: hostB.env }).stateDir;
  let peerCheck = jsonOutput(cli(hostA.cli, ['sync', 'check', '--peer', stateB, '--json'], hostA.env), 'Equal peer check');
  remember(peerCheck.status === 'PASS', 'peer-check-pass');

  await put(join(vaultA, 'wiki', 'entities', 'drift.md'), wikiPage('Drift fixture', 'Peer state changes.'));
  jsonOutput(cli(hostA.cli, ['sync', 'run', '--json'], hostA.env), 'Divergent peer check setup');
  peerCheck = jsonOutput(cli(hostA.cli, ['sync', 'check', '--peer', stateB, '--json'], hostA.env), 'Drift peer check');
  remember(peerCheck.status === 'DRIFT', 'peer-check-drift');
  jsonOutput(cli(hostB.cli, ['sync', 'run', '--json'], hostB.env), 'Drift reconciliation');
  peerCheck = jsonOutput(cli(hostA.cli, ['sync', 'check', '--peer', stateB, '--json'], hostA.env), 'Reconciled peer check');
  remember(peerCheck.status === 'PASS', 'peer-check-pass-after-pull');

  const indexA = join(vaultA, 'wiki', 'index.md');
  const indexB = join(vaultB, 'wiki', 'index.md');
  const logA = join(vaultA, 'wiki', 'log.md');
  const logB = join(vaultB, 'wiki', 'log.md');
  const indexBase = await readFile(indexA, 'utf8');
  const logBase = await readFile(logA, 'utf8');
  await put(indexA, `${indexBase.trimEnd()}\n- [From A](wiki/entities/from-a.md) — fixture\n`);
  await put(logA, `${logBase.trimEnd()}\n\n- [2026-11-08T10:00:00Z] entry from A\n`);
  await put(indexB, `${indexBase.trimEnd()}\n- [From B](wiki/entities/from-b.md) — fixture\n`);
  await put(logB, `${logBase.trimEnd()}\n\n- [2026-11-08T10:01:00Z] entry from B\n`);
  jsonOutput(cli(hostA.cli, ['sync', 'run', '--json'], hostA.env), 'Canonical A changes');
  const canonicalMerge = jsonOutput(cli(hostB.cli, ['sync', 'run', '--json'], hostB.env), 'Canonical three-way merge');
  const mergedIndex = await readFile(indexB, 'utf8');
  const mergedLog = await readFile(logB, 'utf8');
  remember(canonicalMerge.status === 'SYNCED' && canonicalMerge.merged >= 2, 'canonical-three-way-merge');
  remember(mergedIndex.includes('From A') && mergedIndex.includes('From B'), 'index-keeps-both-additions');
  remember(mergedLog.includes('entry from A') && mergedLog.includes('entry from B'), 'log-keeps-both-additions');
  jsonOutput(cli(hostA.cli, ['sync', 'run', '--json'], hostA.env), 'Canonical merge peer pull');
  peerCheck = jsonOutput(cli(hostA.cli, ['sync', 'check', '--peer', stateB, '--json'], hostA.env), 'Canonical merge peer check');
  remember(peerCheck.status === 'PASS', 'canonical-merge-peer-pass');

  const conflictPath = 'wiki/entities/concurrent.md';
  const conflictFileA = join(vaultA, conflictPath);
  const conflictFileB = join(vaultB, conflictPath);
  await put(conflictFileA, wikiPage('Concurrent fixture', 'Base version.'));
  jsonOutput(cli(hostA.cli, ['sync', 'run', '--json'], hostA.env), 'Conflict base push');
  jsonOutput(cli(hostB.cli, ['sync', 'run', '--json'], hostB.env), 'Conflict base pull');
  const localVersion = wikiPage('Concurrent fixture', 'Host B version.');
  const remoteVersion = wikiPage('Concurrent fixture', 'Host A version.');
  await put(conflictFileA, remoteVersion);
  await put(conflictFileB, localVersion);
  jsonOutput(cli(hostA.cli, ['sync', 'run', '--json'], hostA.env), 'Concurrent A push');
  const conflictResult = jsonOutput(cli(hostB.cli, ['sync', 'run', '--json'], hostB.env), 'Concurrent B reconciliation');
  remember(conflictResult.status === 'CONFLICT' && conflictResult.conflicts.some(row => row.path === conflictPath), 'concurrent-edit-conflict');
  const conflictCopy = conflictResult.conflicts.find(row => row.path === conflictPath)?.conflictCopy;
  remember(typeof conflictCopy === 'string' && conflictCopy.startsWith('wiki/entities/'), 'conflict-copy-created');
  if (typeof conflictCopy === 'string') {
    const conflictText = await readFile(join(vaultB, conflictCopy), 'utf8');
    remember(conflictText === remoteVersion, 'conflict-copy-keeps-remote');
  }
  const journalPath = join(stateB, 'sync', 'journal.json');
  const conflictsPath = join(stateB, 'sync', 'conflicts.json');
  const journalText = await readFile(journalPath, 'utf8');
  const conflictRows = JSON.parse(await readFile(conflictsPath, 'utf8'));
  remember(JSON.parse(journalText).operations.some(row => row.action === 'conflict-edit-conflict' && row.state === 'conflict'), 'conflict-journal-entry');
  remember(conflictRows.some(row => row.path === conflictPath && row.conflictCopy === conflictCopy), 'conflict-state-record');
  remember(!journalText.includes('Host A version') && !journalText.includes('Host B version'), 'journal-has-no-page-content');
  await put(conflictFileB, remoteVersion);
  jsonOutput(cli(hostB.cli, ['sync', 'run', '--json'], hostB.env), 'Conflict resolution sync');
  jsonOutput(cli(hostA.cli, ['sync', 'run', '--json'], hostA.env), 'Resolved conflict peer sync');
  peerCheck = jsonOutput(cli(hostA.cli, ['sync', 'check', '--peer', stateB, '--json'], hostA.env), 'Resolved conflict peer check');
  remember(peerCheck.status === 'PASS', 'resolved-conflict-peer-pass');

  const secret = `sk-ant-${randomBytes(24).toString('hex')}`;
  const secretPath = 'wiki/entities/safety-check.md';
  const secretFile = join(vaultA, secretPath);
  const secretGenerated = new Date(Date.now() - 60_000).toISOString();
  await put(secretFile, `---\ntype: concept\ngenerated: '${secretGenerated}'\nstatus: proposed\nsources: []\nverified: []\nstale_after: P90D\naliases: []\nkeywords: []\n---\n\napi_key: "${secret}"\n`);
  const secretSync = cli(hostA.cli, ['sync', 'run', '--json'], hostA.env);
  const secretResult = jsonOutput(secretSync, 'Secret refusal sync');
  remember(secretResult.refused.some(row => row.path === secretPath), 'secret-page-refused');
  remember(!secretSync.stdout.includes(secret) && !secretSync.stderr.includes(secret), 'secret-absent-from-cli-output');
  const bareObjects = run('git', ['--git-dir', bareRemote, 'cat-file', '--batch-all-objects', '--batch'], envA, { encoding: 'buffer' });
  assertSuccess(bareObjects, 'Bare repository object inspection');
  const objectBytes = Buffer.isBuffer(bareObjects.stdout) ? bareObjects.stdout : Buffer.from(bareObjects.stdout ?? '');
  remember(!objectBytes.includes(Buffer.from(secret)), 'secret-absent-from-git-objects');
  remember(!journalText.includes(secret), 'secret-absent-from-sync-journal');

  const deletePath = 'wiki/entities/delete-check.md';
  await put(join(vaultA, deletePath), wikiPage('Delete fixture', 'Deletion requires approval.'));
  jsonOutput(cli(hostA.cli, ['sync', 'run', '--json'], hostA.env), 'Delete fixture push');
  jsonOutput(cli(hostB.cli, ['sync', 'run', '--json'], hostB.env), 'Delete fixture pull');
  await rm(join(vaultA, deletePath));
  const queuedDelete = jsonOutput(cli(hostA.cli, ['sync', 'run', '--json'], hostA.env), 'Delete request queue');
  remember(queuedDelete.status === 'PENDING' && queuedDelete.pendingDeletes === 1, 'delete-queues-for-approval');
  jsonOutput(cli(hostB.cli, ['sync', 'run', '--json'], hostB.env), 'Peer observes pending delete');
  const peerApproval = cli(hostB.cli, ['sync', 'approve', deletePath], hostB.env);
  if (peerApproval.status === 0) {
    let approvalResult;
    try { approvalResult = JSON.parse(peerApproval.stdout); }
    catch { approvalResult = null; }
    remember(Array.isArray(approvalResult?.approved) && approvalResult.approved.includes(deletePath), 'peer-approval-result');
  } else {
    issues.push('peer-cannot-approve-origin-host-delete');
    const originApproval = jsonOutput(cli(hostA.cli, ['sync', 'approve', deletePath], hostA.env), 'Origin-host delete approval fallback');
    remember(Array.isArray(originApproval.approved) && originApproval.approved.includes(deletePath), 'origin-delete-approval');
  }
  jsonOutput(cli(hostB.cli, ['sync', 'run', '--json'], hostB.env), 'Approved delete delivery');
  jsonOutput(cli(hostA.cli, ['sync', 'run', '--json'], hostA.env), 'Approved delete acknowledgement');
  peerCheck = jsonOutput(cli(hostA.cli, ['sync', 'check', '--peer', stateB, '--json'], hostA.env), 'Delete peer check');
  remember(peerCheck.status === 'PASS', 'delete-peer-pass');
  const deletedOnPeer = await lstat(join(vaultB, deletePath)).then(() => true).catch(() => false);
  remember(!deletedOnPeer, 'approved-delete-removed-peer-copy');

  for (const host of hosts) {
    const strict = cli(host.cli, ['okf', 'check', '--strict', '--json'], host.env);
    let findings = null;
    try { findings = JSON.parse(strict.stdout).findings; } catch {}
    if (strict.status !== 0 || !Array.isArray(findings) || findings.length) {
      const detail = Array.isArray(findings) ? findings.map(row => `${row.path}:${row.rule}`).join('+') : 'invalid-output';
      issues.push(`strict-okf-${host.id}:${detail}`);
    }
    const review = jsonOutput(cli(host.cli, ['review', 'list', '--json'], host.env), 'Empty review queue');
    remember(Array.isArray(review) && review.length === 0, `review-empty-${host.id}`);
  }

  for (const host of hosts) {
    const removed = jsonOutput(cli(host.cli, ['uninstall', '--json'], host.env), 'Full release uninstall');
    remember(removed.vaultPreserved === true, `vault-preserved-${host.id}`);
    const keptVault = await lstat(host.vault).then(info => info.isDirectory()).catch(() => false);
    remember(keptVault, `vault-exists-${host.id}`);
    const after = await snapshot(host.home, ['vault']);
    const baseline = host === hostA ? beforeA : beforeB;
    remember(isDeepStrictEqual(after, baseline), `home-restored-${host.id}`);
  }
  const afterA = await snapshot(homeA, ['vault']);
  const afterB = await snapshot(homeB, ['vault']);
  remember(isDeepStrictEqual(afterA, afterB), 'fake-home-snapshots-match');
  assert.deepEqual(issues, [], 'Full E2E acceptance issues detected by stable identifiers');
});
