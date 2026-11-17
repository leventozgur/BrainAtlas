// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { appendFile, chmod, link, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const script = join(root, 'scripts', 'release-verify.mjs');
const version = '9.9.9-test.1';
const hasSshKeygen = !spawnSync('ssh-keygen', ['-l'], { stdio: 'ignore' }).error;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function run(args, env, cwd = root, input = '') {
  return spawnSync(process.execPath, [script, ...args], { cwd, env, encoding: 'utf8', input, timeout: 300_000, maxBuffer: 8 * 1024 * 1024 });
}

async function createKey(directory, name) {
  const key = join(directory, name);
  const result = spawnSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-q', '-f', key], { stdio: 'ignore' });
  assert.equal(result.status, 0, 'a throwaway signing key could not be created');
  return key;
}

function sign(key, cwd) {
  const result = spawnSync('ssh-keygen', ['-Y', 'sign', '-f', key, '-n', 'brainatlas-release', 'SHA256SUMS'], { cwd, stdio: 'ignore' });
  assert.equal(result.status, 0, 'the checksum list could not be signed');
}

async function fixture(options = {}) {
  const { overrides = {}, distOverrides = {}, excludeFromDist = [], extraFiles = {}, archiveExtraPaths = [], version: fixtureVersion = version } = options;
  const base = await mkdtemp(join(tmpdir(), 'brainatlas-release-verify-test-'));
  const folder = join(base, 'release-folder');
  const stage = join(base, 'stage');
  const distName = `brainatlas-${fixtureVersion}`;
  const dist = join(stage, distName);
  await mkdir(join(folder, 'release'), { recursive: true });
  await mkdir(join(dist, 'release'), { recursive: true });
  const key = await createKey(base, 'signing_key');
  const publicKey = (await readFile(`${key}.pub`, 'utf8')).trim();
  const signers = `brainatlas-release namespaces="brainatlas-release" ${publicKey}\n`;
  await writeFile(join(base, 'trusted_signers'), signers);
  const files = {
    'install.sh': '#!/bin/sh\nexit 0\n',
    'release/install-kit.mjs': '// install kit\n',
    'release/allowed_signers': signers,
    [`brainatlas-${fixtureVersion}-full.tgz`]: 'full archive\n',
    [`brainatlas-${fixtureVersion}-lite.tgz`]: 'lite archive\n',
    ...overrides
  };
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(folder, name), content);
    if (!excludeFromDist.includes(name)) await writeFile(join(dist, name), distOverrides[name] ?? content);
  }
  for (const [name, content] of Object.entries(extraFiles)) {
    const path = join(stage, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
  const archiveName = `brainatlas-${fixtureVersion}-distribution.tar.gz`;
  const listed = Object.keys(files).map(name => ({ name, hash: sha256(Buffer.from(files[name])) })).sort((a, b) => (a.name < b.name ? -1 : 1));
  const sums = `${listed.map(entry => `${entry.hash}  ${entry.name}`).join('\n')}\n`;
  await writeFile(join(folder, 'SHA256SUMS'), sums);
  await writeFile(join(dist, 'SHA256SUMS'), sums);
  sign(key, dist);
  await writeFile(join(folder, 'SHA256SUMS.sig'), await readFile(join(dist, 'SHA256SUMS.sig')));
  const tarred = spawnSync('tar', ['-czf', join(folder, archiveName), distName, ...archiveExtraPaths], { cwd: stage, stdio: 'ignore' });
  assert.equal(tarred.status, 0, 'the distribution archive could not be created');
  return { base, folder, key, env: { ...process.env, BRAINATLAS_RELEASE_VERIFY_SIGNERS: join(base, 'trusted_signers') } };
}

async function cleanup(base) { await rm(base, { recursive: true, force: true }); }

async function pathWithoutSshKeygen(base) {
  const bin = join(base, 'bin');
  await mkdir(bin);
  for (const command of ['tar', 'sh']) {
    const found = spawnSync('sh', ['-c', `command -v ${command}`], { encoding: 'utf8' }).stdout.trim();
    assert.ok(found, `${command} is required for this test`);
    await symlink(found, join(bin, command));
  }
  return bin;
}

test('all checks pass with --skip-install', { skip: !hasSshKeygen && 'ssh-keygen is not available' }, async () => {
  const { base, folder, env } = await fixture();
  try {
    const result = await run(['--dir', folder, '--version', version, '--skip-install'], env);
    assert.equal(result.status, 0);
    for (const id of ['files', 'checksums', 'allowed-signers', 'signature', 'distribution', 'version']) assert.match(result.stdout, new RegExp(`^PASS ${id}$`, 'm'));
    assert.match(result.stdout, /^PASS install: skipped$/m);
    const json = await run(['--dir', folder, '--version', version, '--skip-install', '--json'], env);
    assert.equal(json.status, 0);
    const report = JSON.parse(json.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.version, version);
    assert.equal(report.checks.length, 7);
  } finally { await cleanup(base); }
});

test('the install check runs the installer and doctor with a temporary HOME', { skip: !hasSshKeygen && 'ssh-keygen is not available' }, async () => {
  const installer = [
    '#!/bin/sh',
    'set -eu',
    'test -z "${BRAINATLAS_REAL_HOME_FOR_TEST:-}"',
    'test -z "${BRAINATLAS_SECRET_MARKER:-}"',
    'test -z "${NODE_OPTIONS:-}"',
    'case "$HOME" in */home) ;; *) exit 3 ;; esac',
    'case "$XDG_DATA_HOME" in "$HOME"/*) ;; *) exit 4 ;; esac',
    'if [ "$(uname -s)" = Darwin ]; then data="$HOME/Library/Application Support/BrainAtlas"; else data="$XDG_DATA_HOME/brainatlas"; fi',
    'mkdir -p "$data/bin"',
    'cat > "$data/bin/brainatlas" <<\'LAUNCHER\'',
    '#!/bin/sh',
    'printf \'{"ok":true}\\n\'',
    'LAUNCHER',
    'chmod +x "$data/bin/brainatlas"',
    "printf '%s\\n' 'brainatlas'"
  ].join('\n');
  const { base, folder, env } = await fixture({ overrides: { 'install.sh': installer } });
  try {
    const result = await run(['--dir', folder, '--version', version], {
      ...env,
      BRAINATLAS_REAL_HOME_FOR_TEST: process.env.HOME ?? '',
      BRAINATLAS_SECRET_MARKER: 'secret',
      NODE_OPTIONS: '--no-warnings'
    });
    assert.equal(result.status, 0, result.stdout);
    assert.match(result.stdout, /^PASS install$/m);
  } finally { await cleanup(base); }
});

test('a signers override is noted once and reported in --json', { skip: !hasSshKeygen && 'ssh-keygen is not available' }, async () => {
  const { base, folder, env } = await fixture();
  try {
    const text = await run(['--dir', folder, '--version', version, '--skip-install'], env);
    assert.equal(text.status, 0);
    assert.equal(text.stdout.split('\n').filter(line => line.startsWith('NOTE allowed_signers overridden by BRAINATLAS_RELEASE_VERIFY_SIGNERS')).length, 1);
    const json = await run(['--dir', folder, '--version', version, '--skip-install', '--json'], env);
    assert.equal(json.status, 0);
    assert.equal(JSON.parse(json.stdout).signersOverride, true);
    assert.doesNotMatch(json.stdout, /NOTE allowed_signers/);
  } finally { await cleanup(base); }
});

test('a modified archive byte fails checksums', { skip: !hasSshKeygen && 'ssh-keygen is not available' }, async () => {
  const { base, folder, env } = await fixture();
  try {
    await appendFile(join(folder, `brainatlas-${version}-full.tgz`), 'x');
    const result = await run(['--dir', folder, '--version', version, '--skip-install'], env);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /^FAIL checksums: /m);
  } finally { await cleanup(base); }
});

test('--json reports a failing check and the failing exit code', { skip: !hasSshKeygen && 'ssh-keygen is not available' }, async () => {
  const { base, folder, env } = await fixture();
  try {
    await appendFile(join(folder, `brainatlas-${version}-full.tgz`), 'x');
    const result = await run(['--dir', folder, '--version', version, '--skip-install', '--json'], env);
    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, false);
    assert.doesNotMatch(result.stdout, /^(PASS|FAIL) /m);
    const checksums = report.checks.find(check => check.id === 'checksums');
    assert.equal(checksums.ok, false);
    assert.equal(typeof checksums.reason, 'string');
    assert.ok(checksums.reason.length > 0);
    assert.equal(report.checks.find(check => check.id === 'files').ok, true);
  } finally { await cleanup(base); }
});

test('a missing SHA256SUMS.sig fails files and skips the rest', { skip: !hasSshKeygen && 'ssh-keygen is not available' }, async () => {
  const { base, folder, env } = await fixture();
  try {
    await rm(join(folder, 'SHA256SUMS.sig'));
    const result = await run(['--dir', folder, '--version', version, '--skip-install'], env);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /^FAIL files: /m);
    assert.match(result.stdout, /^FAIL checksums: not run$/m);
    assert.match(result.stdout, /^FAIL install: not run$/m);
  } finally { await cleanup(base); }
});

test('a symlinked release directory fails files', { skip: !hasSshKeygen && 'ssh-keygen is not available' }, async () => {
  const { base, folder, env } = await fixture();
  try {
    await rename(join(folder, 'release'), join(base, 'real-release'));
    await symlink(join(base, 'real-release'), join(folder, 'release'));
    const result = await run(['--dir', folder, '--version', version, '--skip-install'], env);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /^FAIL files: .*release\//m);
    assert.match(result.stdout, /^FAIL signature: not run$/m);
  } finally { await cleanup(base); }
});

test('a different allowed_signers copy fails allowed-signers', { skip: !hasSshKeygen && 'ssh-keygen is not available' }, async () => {
  const { base, folder, env } = await fixture();
  try {
    await appendFile(join(folder, 'release', 'allowed_signers'), '# extra\n');
    const result = await run(['--dir', folder, '--version', version, '--skip-install'], env);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /^FAIL allowed-signers: /m);
    assert.match(result.stdout, /^PASS signature$/m);
  } finally { await cleanup(base); }
});

test('a signature by another key fails signature and skips install', { skip: !hasSshKeygen && 'ssh-keygen is not available' }, async () => {
  const { base, folder, env } = await fixture();
  try {
    const other = await createKey(base, 'other_key');
    await rm(join(folder, 'SHA256SUMS.sig'));
    sign(other, folder);
    const result = await run(['--dir', folder, '--version', version], env);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /^FAIL signature: /m);
    assert.match(result.stdout, /^FAIL install: not run$/m);
    const json = await run(['--dir', folder, '--version', version, '--json'], env);
    assert.equal(json.status, 1);
    const install = JSON.parse(json.stdout).checks.find(check => check.id === 'install');
    assert.equal(install.ok, false);
    assert.equal(install.reason, 'not run');
  } finally { await cleanup(base); }
});

test('ssh-keygen not found fails signature', { skip: !hasSshKeygen && 'ssh-keygen is not available' }, async () => {
  const { base, folder, env } = await fixture();
  try {
    const bin = await pathWithoutSshKeygen(base);
    const result = await run(['--dir', folder, '--version', version, '--skip-install'], { ...env, PATH: bin });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /^FAIL signature: ssh-keygen not found$/m);
    assert.match(result.stdout, /^FAIL install: not run$/m);
    assert.match(result.stdout, /^PASS distribution$/m);
  } finally { await cleanup(base); }
});

test('a distribution copy of install.sh that differs fails distribution', { skip: !hasSshKeygen && 'ssh-keygen is not available' }, async () => {
  const { base, folder, env } = await fixture({ distOverrides: { 'install.sh': '#!/bin/sh\nexit 1\n' } });
  try {
    const result = await run(['--dir', folder, '--version', version, '--skip-install'], env);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /^PASS checksums$/m);
    assert.match(result.stdout, /^FAIL distribution: content differs: install\.sh$/m);
  } finally { await cleanup(base); }
});

test('a deep a/b/install.sh archive entry does not match install.sh', { skip: !hasSshKeygen && 'ssh-keygen is not available' }, async () => {
  const { base, folder, env } = await fixture({
    excludeFromDist: ['install.sh'],
    extraFiles: { 'a/b/install.sh': '#!/bin/sh\nexit 0\n' },
    archiveExtraPaths: ['a']
  });
  try {
    const result = await run(['--dir', folder, '--version', version, '--skip-install'], env);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /^FAIL distribution: unexpected entry path in archive: (a\/b|foo)\/?/m);
  } finally { await cleanup(base); }
});

test('rc-suffixed archive names fail the strict version check', { skip: !hasSshKeygen && 'ssh-keygen is not available' }, async () => {
  const { base, folder, env } = await fixture({
    version: '0.1.0',
    overrides: { 'brainatlas-0.1.0-rc.12-full.tgz': 'rc archive\n' }
  });
  try {
    const result = await run(['--dir', folder, '--version', '0.1.0', '--skip-install'], env);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /^PASS files$/m);
    assert.match(result.stdout, /^PASS checksums$/m);
    assert.match(result.stdout, /^PASS distribution$/m);
    assert.match(result.stdout, /^FAIL version: .*(brainatlas-0\.1\.0-rc\.12-full\.tgz)/m);
  } finally { await cleanup(base); }
});

test('a brainatlas-9.9.9 top-level directory inside the distribution archive fails version', { skip: !hasSshKeygen && 'ssh-keygen is not available' }, async () => {
  const { base, folder, env } = await fixture({
    extraFiles: { 'brainatlas-9.9.9/README': 'nested\n' },
    archiveExtraPaths: ['brainatlas-9.9.9']
  });
  try {
    const result = await run(['--dir', folder, '--version', version, '--skip-install'], env);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /^PASS files$/m);
    assert.match(result.stdout, /^FAIL distribution: unexpected entry path in archive/m);
    assert.match(result.stdout, /^FAIL version: .*(brainatlas-9\.9\.9)/m);
  } finally { await cleanup(base); }
});

test('an archive entry name containing a newline fails distribution', { skip: !hasSshKeygen && 'ssh-keygen is not available' }, async () => {
  const { base, folder, env } = await fixture({
    extraFiles: { 'bad\nname': 'x\n' },
    archiveExtraPaths: ['bad\nname']
  });
  try {
    const result = await run(['--dir', folder, '--version', version, '--skip-install'], env);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /^FAIL distribution: unexpected entry name in archive$/m);
  } finally { await cleanup(base); }
});

test('a foo/install.sh entry does not match install.sh', { skip: !hasSshKeygen && 'ssh-keygen is not available' }, async () => {
  const { base, folder, env } = await fixture({
    excludeFromDist: ['install.sh'],
    extraFiles: { 'foo/install.sh': '#!/bin/sh\nexit 0\n' },
    archiveExtraPaths: ['foo']
  });
  try {
    const result = await run(['--dir', folder, '--version', version, '--skip-install'], env);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /^FAIL distribution: unexpected entry path in archive: (a\/b|foo)\/?/m);
  } finally { await cleanup(base); }
});

test('nested brainatlas- segments fail the version check', { skip: !hasSshKeygen && 'ssh-keygen is not available' }, async () => {
  for (const extra of ['other/brainatlas-9.9.9/x', 'foo/brainatlas-0.0.1-full.tgz', 'sub/brainatlas-9.9.9-test.1']) {
    const top = extra.split('/')[0];
    const { base, folder, env } = await fixture({ extraFiles: { [extra]: 'x\n' }, archiveExtraPaths: [top] });
    try {
      const result = await run(['--dir', folder, '--version', version, '--skip-install'], env);
      assert.equal(result.status, 1, extra);
      assert.match(result.stdout, /^FAIL version: archive entry does not match version: /m, extra);
    } finally { await cleanup(base); }
  }
});

test('symlink and hard-link entries fail distribution', { skip: !hasSshKeygen && 'ssh-keygen is not available' }, async () => {
  for (const kind of ['symlink', 'hardlink']) {
    const { base, folder, env } = await fixture();
    try {
      const work = await mkdtemp(join(tmpdir(), 'brainatlas-release-verify-link-'));
      try {
        const stage = join(work, 'stage');
        const dist = join(stage, `brainatlas-${version}`);
        await mkdir(dist, { recursive: true });
        await writeFile(join(dist, 'install.sh'), 'x\n');
        if (kind === 'symlink') await symlink('install.sh', join(dist, 'link'));
        else await link(join(dist, 'install.sh'), join(dist, 'link'));
        const archive = join(folder, `brainatlas-${version}-distribution.tar.gz`);
        assert.equal(spawnSync('tar', ['-czf', archive, `brainatlas-${version}`], { cwd: stage }).status, 0);
      } finally { await rm(work, { recursive: true, force: true }); }
      const result = await run(['--dir', folder, '--version', version, '--skip-install'], env);
      assert.equal(result.status, 1, kind);
      assert.match(result.stdout, /^FAIL distribution: link entry in archive: /m, kind);
    } finally { await cleanup(base); }
  }
});

test('control characters in release folder names are escaped in reasons', { skip: !hasSshKeygen && 'ssh-keygen is not available' }, async () => {
  const { base, folder, env } = await fixture();
  try {
    await rm(join(folder, 'SHA256SUMS.sig'));
    await writeFile(join(folder, 'evil\u001b[31mname'), 'x');
    const result = await run(['--dir', folder, '--version', version, '--skip-install'], env);
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stdout, /\u001b/);
    assert.match(result.stdout, /extra: .*evil\\x1b\[31mname/);
  } finally { await cleanup(base); }
});

test('an unexpected foo/bar archive entry fails distribution', { skip: !hasSshKeygen && 'ssh-keygen is not available' }, async () => {
  const { base, folder, env } = await fixture({ extraFiles: { 'foo/bar': 'x\n' }, archiveExtraPaths: ['foo'] });
  try {
    const result = await run(['--dir', folder, '--version', version, '--skip-install'], env);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /^FAIL distribution: unexpected entry path in archive: foo\/?(bar)?$/m);
  } finally { await cleanup(base); }
});

function tarHeader(name, mode, type, size) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 'utf8');
  header.write(`${mode.toString(8).padStart(7, '0')}\0`, 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  header.write('00000000000\0', 136);
  header.write('        ', 148);
  header.write(type, 156);
  header.write('ustar\0', 257);
  header.write('00', 263);
  const sum = header.reduce((total, byte) => total + byte, 0);
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return header;
}

test('mode 000 archive entries do not break extraction or cleanup', { skip: !hasSshKeygen && 'ssh-keygen is not available' }, async () => {
  const { base, folder, env } = await fixture();
  try {
    const content = Buffer.from('x\n');
    const pad = Buffer.alloc(512 - content.length);
    const blocks = [tarHeader('release/', 0o000, '5', 0), tarHeader('release/locked/', 0o000, '5', 0), tarHeader('release/locked/f', 0o000, '0', content.length), content, pad, Buffer.alloc(1024)];
    const { gzipSync } = await import('node:zlib');
    await writeFile(join(folder, `brainatlas-${version}-distribution.tar.gz`), gzipSync(Buffer.concat(blocks)));
    const result = await run(['--dir', folder, '--version', version, '--skip-install'], env);
    assert.doesNotMatch(result.stdout, /^NOTE temporary directory/m);
    assert.doesNotMatch(result.stdout, /extracted tree could not be read/);
    assert.match(result.stdout, /^FAIL distribution: missing entry: /m);
  } finally { await cleanup(base); }
});

test('an unsafe ../evil entry name fails distribution before extraction', { skip: !hasSshKeygen && 'ssh-keygen is not available' }, async () => {
  const { base, folder, env } = await fixture({ extraFiles: { 'evil': 'x\n' } });
  try {
    const archive = join(folder, `brainatlas-${version}-distribution.tar.gz`);
    const stage = join(base, 'stage');
    let made = spawnSync('tar', ['-czf', archive, '-s', ',^evil$,../evil,', `brainatlas-${version}`, 'evil'], { cwd: stage, stdio: 'ignore' });
    if (made.status !== 0) made = spawnSync('tar', ['-czf', archive, '--transform', 's,^evil$,../evil,', `brainatlas-${version}`, 'evil'], { cwd: stage, stdio: 'ignore' });
    if (made.status !== 0) return;
    const listing = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8' }).stdout;
    if (!listing.split('\n').includes('../evil')) return;
    const result = await run(['--dir', folder, '--version', version, '--skip-install'], env);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /^FAIL distribution: unsafe entry name in archive: \.\.\/evil$/m);
  } finally { await cleanup(base); }
});

test('usage errors exit with code 2', async () => {
  const missing = await run([]);
  assert.equal(missing.status, 2);
  assert.equal(missing.stdout, '');
  assert.equal(missing.stderr.trim().split('\n').length, 1);
  assert.match(missing.stderr, /usage:/);
  const unknown = await run(['--dir', tmpdir(), '--bogus']);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /usage:/);
});
