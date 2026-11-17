// SPDX-License-Identifier: MIT
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const USAGE = 'usage: node scripts/release-verify.mjs --dir <release folder> [--version <v>] [--skip-install] [--json]';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const signersOverride = Boolean(process.env.BRAINATLAS_RELEASE_VERIFY_SIGNERS);
const trustedSigners = resolve(
  process.env.BRAINATLAS_RELEASE_VERIFY_SIGNERS || join(root, 'release', 'allowed_signers')
);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const safeVersion = (value) =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) && value !== '..';
const fail = (reason) => ({ ok: false, reason });

class ListingError extends Error {}

const notes = [];

async function restorePermissions(path) {
  let stat;
  try {
    stat = await lstat(path);
  } catch {
    return;
  }
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    await chmod(path, 0o700).catch(() => {});
    for (const name of await readdir(path).catch(() => [])) await restorePermissions(join(path, name));
  } else await chmod(path, 0o600).catch(() => {});
}

const tempDirs = new Set();
async function makeTemp(prefix) {
  const path = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.add(path);
  return path;
}
function cleanTempSync() {
  for (const path of tempDirs) {
    try {
      spawnSync('chmod', ['-R', 'u+rwX', path], { stdio: 'ignore' });
      rmSync(path, { recursive: true, force: true });
    } catch {
      /* best effort on a signal */
    }
  }
  tempDirs.clear();
}
for (const [signal, code] of /** @type {Array<[NodeJS.Signals, number]>} */ ([
  ['SIGINT', 130],
  ['SIGTERM', 143],
]))
  process.on(signal, () => {
    cleanTempSync();
    process.exit(code);
  });

async function cleanTemp(path) {
  if (!path) return;
  try {
    await restorePermissions(path);
    await rm(path, { recursive: true, force: true });
    tempDirs.delete(path);
  } catch (error) {
    notes.push(`temporary directory could not be removed: ${basename(path)} (${error?.code ?? 'error'})`);
  }
}

function archiveFileNames(version) {
  return [
    `brainatlas-${version}-distribution.tar.gz`,
    `brainatlas-${version}-full.tgz`,
    `brainatlas-${version}-lite.tgz`,
  ];
}

function parseArgs(argv) {
  const options = { dir: '', version: '', skipInstall: false, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--skip-install') options.skipInstall = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--dir' || arg === '--version') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) return null;
      if (arg === '--dir') options.dir = value;
      else options.version = value;
      index += 1;
    } else return null;
  }
  if (!options.dir) return null;
  return options;
}

async function regularFiles(base, names) {
  const missing = [];
  for (const name of names) {
    try {
      const stat = await lstat(join(base, name));
      if (!stat.isFile()) missing.push(name);
    } catch {
      missing.push(name);
    }
  }
  return missing;
}

async function checkFiles(dir, version) {
  const top = [...archiveFileNames(version), 'install.sh', 'SHA256SUMS', 'SHA256SUMS.sig'];
  const missing = await regularFiles(dir, [...top, 'release/install-kit.mjs', 'release/allowed_signers']);
  try {
    const stat = await lstat(join(dir, 'release'));
    if (!stat.isDirectory()) missing.push('release/');
  } catch {
    missing.push('release/');
  }
  if (!missing.length) return { ok: true };
  const names = [...new Set(missing)];
  let extra;
  try {
    extra = (await readdir(dir, { withFileTypes: true }))
      .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && !top.includes(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    extra = [];
  }
  const reason = `missing: ${names.join(', ')}${extra.length ? `; extra: ${extra.join(', ')}` : ''}`;
  return fail(reason);
}

async function checkChecksums(dir, version) {
  const text = await readFile(join(dir, 'SHA256SUMS'), 'utf8');
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  const listed = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = /^([a-f0-9]{64}) {2}(.+)$/.exec(line);
    if (!match) return fail(`malformed line ${index + 1}`);
    const name = match[2];
    const parts = name.split('/');
    if (
      name.startsWith('/') ||
      name.includes('\\') ||
      name.includes(' ') ||
      parts.some((part) => !part || part === '.' || part === '..')
    )
      return fail(`malformed line ${index + 1}`);
    listed.push({ name, hash: match[1] });
  }
  const names = new Set();
  for (const entry of listed) {
    if (names.has(entry.name)) return fail(`duplicate entry: ${entry.name}`);
    names.add(entry.name);
  }
  for (const required of [
    ...archiveFileNames(version).slice(1),
    'install.sh',
    'release/allowed_signers',
    'release/install-kit.mjs',
  ]) {
    if (!names.has(required)) return fail(`missing entry: ${required}`);
  }
  for (const entry of listed) {
    let bytes;
    try {
      const stat = await lstat(join(dir, entry.name));
      if (!stat.isFile()) return fail(`not a regular file: ${entry.name}`);
      bytes = await readFile(join(dir, entry.name));
    } catch {
      return fail(`missing file: ${entry.name}`);
    }
    if (sha256(bytes) !== entry.hash) return fail(`checksum mismatch: ${entry.name}`);
  }
  return { ok: true };
}

async function checkAllowedSigners(dir) {
  const local = await readFile(join(dir, 'release', 'allowed_signers'));
  const trusted = await readFile(trustedSigners);
  return local.equals(trusted) ? { ok: true } : fail('release/allowed_signers differs from the repository copy');
}

async function checkSignature(dir) {
  const sums = await readFile(join(dir, 'SHA256SUMS'));
  try {
    execFileSync(
      'ssh-keygen',
      [
        '-Y',
        'verify',
        '-f',
        trustedSigners,
        '-I',
        'brainatlas-release',
        '-n',
        'brainatlas-release',
        '-s',
        join(dir, 'SHA256SUMS.sig'),
      ],
      { input: sums, stdio: ['pipe', 'ignore', 'ignore'] }
    );
    return { ok: true };
  } catch (error) {
    if (error?.code === 'ENOENT') return fail('ssh-keygen not found');
    return fail('signature verification failed');
  }
}

// eslint-disable-next-line no-control-regex -- archive member names are checked for control characters on purpose
const hasControl = (name) => /[\\\u0000-\u001f\u007f-\u009f]/.test(name);

async function walkTree(base, relative, types) {
  for (const entry of await readdir(join(base, relative), { withFileTypes: true })) {
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    if (hasControl(entry.name)) throw new ListingError('unexpected entry name in archive');
    const stat = await lstat(join(base, path));
    if (stat.isSymbolicLink()) types.set(path, 'l');
    else if (stat.isDirectory()) {
      types.set(path, 'd');
      await walkTree(base, path, types);
    } else if (stat.isFile()) types.set(path, stat.nlink > 1 ? 'h' : '-');
    else types.set(path, 'o');
  }
}

// The archive is listed once with `tar -tzf` (names only, one per line) and
// extracted once into `work`. Entry types come from lstat on the extracted tree,
// so no format-specific `tar -tv` parsing is needed. A name with a control
// character (including a newline that splits the listing) makes the whole
// listing unusable.
async function inspectArchive(archive, work, version) {
  let output;
  try {
    output = execFileSync('tar', ['-tzf', archive], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    throw new Error('distribution archive could not be read');
  }
  const lines = output.split('\n');
  if (lines.pop() !== '') throw new ListingError('unexpected entry name in archive');
  for (const line of lines)
    if (line.length === 0 || hasControl(line)) throw new ListingError('unexpected entry name in archive');
  const names = lines.map((name) => ({ name, type: name.endsWith('/') ? 'd' : '-' }));
  // Every name is validated before anything is extracted.
  for (const { name } of names) {
    if (unsafeName(name)) return { entries: names, reject: `unsafe entry name in archive: ${name}` };
    if (badPrefix(name, version)) return { entries: names, reject: `unexpected entry path in archive: ${name}` };
  }
  try {
    execFileSync('tar', ['-xzf', archive, '-C', work], { stdio: ['ignore', 'ignore', 'ignore'] });
  } catch {
    throw new ListingError('distribution archive could not be extracted');
  }
  await restorePermissions(work);
  const types = new Map();
  try {
    await walkTree(work, '', types);
  } catch (error) {
    if (error instanceof ListingError) throw error;
    throw new ListingError(`extracted tree could not be read: ${error?.code ?? 'error'}`);
  }
  const entries = names.map(({ name }) => ({ name, type: name.endsWith('/') ? 'd' : (types.get(name) ?? '-') }));
  for (const [name, type] of types) if (type === 'l' || type === 'h') entries.push({ name, type });
  return { entries, reject: null };
}

function badPrefix(name, version) {
  const stripped = name.replace(/\/+$/, '');
  const prefix = `brainatlas-${version}/`;
  const rest = stripped.startsWith(prefix)
    ? stripped.slice(prefix.length)
    : stripped === `brainatlas-${version}`
      ? ''
      : stripped;
  return rest !== '' && rest !== 'release' && !rest.startsWith('release/') && rest.includes('/');
}

function entryMatches(entry, name, version) {
  return entry === name || entry === `brainatlas-${version}/${name}`;
}

function unsafeName(name) {
  const parts = name.replace(/\/+$/, '').split('/');
  return name.startsWith('/') || parts.some((part) => part === '' || part === '.' || part === '..');
}

async function checkDistribution(dir, version, work, entries, entriesError, reject) {
  if (entries === null) return fail(entriesError);
  if (reject) return fail(reject);
  for (const entry of entries) {
    if (entry.type === 'l' || entry.type === 'h') return fail(`link entry in archive: ${entry.name}`);
  }
  const files = entries.filter((entry) => entry.type !== 'd' && !entry.name.endsWith('/'));
  const required = [
    `brainatlas-${version}-full.tgz`,
    `brainatlas-${version}-lite.tgz`,
    'install.sh',
    'SHA256SUMS',
    'SHA256SUMS.sig',
    'release/allowed_signers',
    'release/install-kit.mjs',
  ];
  const picked = new Map();
  for (const name of required) {
    const matches = files.filter((entry) => entryMatches(entry.name, name, version));
    if (matches.length === 0) return fail(`missing entry: ${name}`);
    if (matches.length > 1) return fail(`ambiguous entry: ${name}`);
    picked.set(name, matches[0].name);
  }
  for (const [name, entry] of picked) {
    let stat;
    try {
      stat = await lstat(join(work, entry));
    } catch {
      return fail(`extracted copy is missing: ${name}`);
    }
    if (!stat.isFile()) return fail(`extracted copy is not a regular file: ${name}`);
    const [expected, actual] = await Promise.all([readFile(join(dir, name)), readFile(join(work, entry))]);
    if (!expected.equals(actual)) return fail(`content differs: ${name}`);
  }
  return { ok: true };
}

// Strict version matching for a relative path: a `brainatlas-` segment must be
// exactly `brainatlas-<v>` when it is a directory (at most one such prefix
// segment per entry) or exactly one of the three archive file names when it is
// a file name. Prefix matches such as `brainatlas-<v>-rc.1-full.tgz` fail.
function nameVersionOk(name, isDirectory, version) {
  const exact = archiveFileNames(version);
  const versionDir = `brainatlas-${version}`;
  const segments = name.replace(/\/+$/, '').split('/');
  let directories = 0;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (!segment.startsWith('brainatlas-')) continue;
    const last = index === segments.length - 1;
    if (!last || isDirectory) {
      if (segment !== versionDir || index !== 0) return false;
      directories += 1;
      if (directories > 1) return false;
    } else if (!exact.includes(segment)) {
      return false;
    }
  }
  return true;
}

async function checkVersion(dir, version, entries, entriesError) {
  let dirents;
  try {
    dirents = await readdir(dir, { withFileTypes: true });
  } catch {
    return fail('release folder could not be read');
  }
  for (const entry of dirents) {
    if (!nameVersionOk(entry.name, entry.isDirectory(), version))
      return fail(`archive name does not match version: ${entry.name}`);
  }
  let listed;
  try {
    listed = (await readFile(join(dir, 'SHA256SUMS'), 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => /^\S+ {2}(.+)$/.exec(line)?.[1])
      .filter(Boolean);
  } catch {
    return fail('SHA256SUMS could not be read');
  }
  for (const name of listed) {
    if (!nameVersionOk(name, false, version)) return fail(`checksum entry does not match version: ${name}`);
  }
  if (entries === null) return fail(entriesError);
  for (const entry of entries) {
    const isDirectory = entry.type === 'd' || entry.name.endsWith('/');
    if (!nameVersionOk(entry.name, isDirectory, version))
      return fail(`archive entry does not match version: ${entry.name}`);
  }
  return { ok: true };
}

async function extractRoot(base) {
  try {
    const stat = await lstat(join(base, 'install.sh'));
    if (stat.isFile()) return base;
  } catch {
    /* try one nested directory */
  }
  let entries;
  try {
    entries = await readdir(base, { withFileTypes: true });
  } catch {
    return null;
  }
  const directories = entries.filter((entry) => entry.isDirectory());
  if (directories.length !== 1) return null;
  const nested = join(base, directories[0].name);
  try {
    const stat = await lstat(join(nested, 'install.sh'));
    return stat.isFile() ? nested : null;
  } catch {
    return null;
  }
}

async function checkInstall(dir, version) {
  const archive = join(dir, `brainatlas-${version}-distribution.tar.gz`);
  let work = null;
  try {
    try {
      work = await makeTemp('brainatlas-verify-install-');
    } catch {
      return fail('temporary directory could not be created');
    }
    const home = join(work, 'home');
    const distribution = join(work, 'distribution');
    const xdg = {
      XDG_DATA_HOME: join(home, 'xdg', 'data'),
      XDG_CONFIG_HOME: join(home, 'xdg', 'config'),
      XDG_STATE_HOME: join(home, 'xdg', 'state'),
    };
    await mkdir(home);
    await mkdir(distribution);
    try {
      execFileSync('tar', ['-xzf', archive, '-C', distribution], { stdio: ['ignore', 'ignore', 'ignore'] });
    } catch {
      return fail('distribution archive could not be extracted');
    }
    const base = await extractRoot(distribution);
    if (!base) return fail('install.sh is missing from the distribution');
    const installEnv = installEnvironment(home, xdg);
    const installed = spawnSync(
      'sh',
      [
        'install.sh',
        '--from',
        `brainatlas-${version}-full.tgz`,
        '--allowed-signers',
        'release/allowed_signers',
        '--yes',
      ],
      { cwd: base, env: installEnv, stdio: ['ignore', 'ignore', 'ignore'], timeout: 600_000 }
    );
    if (installed.error || installed.status !== 0) return fail('installer failed');
    const dataDir =
      process.platform === 'darwin'
        ? join(home, 'Library', 'Application Support', 'BrainAtlas')
        : join(xdg.XDG_DATA_HOME, 'brainatlas');
    const launcher = join(dataDir, 'bin', 'brainatlas');
    let output;
    try {
      output = execFileSync(launcher, ['doctor', '--json'], {
        env: installEnv,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 120_000,
      });
    } catch {
      return fail('doctor failed');
    }
    let report;
    try {
      report = JSON.parse(output);
    } catch {
      return fail('doctor output was not JSON');
    }
    return report?.ok === true ? { ok: true } : fail('doctor reported not ok');
  } finally {
    await cleanTemp(work);
  }
}

function installEnvironment(home, xdg) {
  const env = { HOME: home, ...xdg };
  if (process.env.PATH) env.PATH = process.env.PATH;
  if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR;
  if (process.env.LANG) env.LANG = process.env.LANG;
  return env;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options) {
    process.stderr.write(`${USAGE}\n`);
    process.exitCode = 2;
    return;
  }
  let version = options.version;
  if (!version) {
    try {
      version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
    } catch {
      version = '';
    }
  }
  if (!safeVersion(version)) {
    process.stderr.write(`${USAGE}\n`);
    process.exitCode = 2;
    return;
  }
  const dir = resolve(options.dir);
  const checks = [];
  const escape = (text) =>
    // eslint-disable-next-line no-control-regex -- archive member names are checked for control characters on purpose
    text.replace(/[\u0000-\u001f\u007f-\u009f]/g, (ch) => `\\x${ch.charCodeAt(0).toString(16).padStart(2, '0')}`);
  const record = (id, result) =>
    checks.push({ id, ok: result.ok, ...(result.reason ? { reason: escape(result.reason) } : {}) });
  const skipRest = (reason) => {
    for (const id of ['checksums', 'allowed-signers', 'signature', 'distribution', 'version', 'install'])
      record(id, fail(reason));
  };

  let files;
  try {
    files = await checkFiles(dir, version);
  } catch {
    files = fail('release folder could not be read');
  }
  record('files', files);
  if (!files.ok) skipRest('not run');
  else {
    // The distribution archive is listed once; both the distribution and the
    // version check reuse that listing.
    const archive = join(dir, `brainatlas-${version}-distribution.tar.gz`);
    let entries = null;
    let entriesError = 'distribution archive could not be read';
    let reject = null;
    let work = null;
    try {
      try {
        try {
          work = await makeTemp('brainatlas-verify-dist-');
        } catch {
          throw new ListingError('temporary directory could not be created');
        }
        ({ entries, reject } = await inspectArchive(archive, work, version));
      } catch (error) {
        if (error instanceof ListingError) entriesError = error.message;
      }
      record('checksums', await runCheck(() => checkChecksums(dir, version), 'checksums could not be verified'));
      record(
        'allowed-signers',
        await runCheck(() => checkAllowedSigners(dir), 'release/allowed_signers could not be read')
      );
      const signature = await runCheck(() => checkSignature(dir), 'signature could not be verified');
      record('signature', signature);
      record(
        'distribution',
        await runCheck(
          () => checkDistribution(dir, version, work, entries, entriesError, reject),
          'distribution could not be verified'
        )
      );
      record(
        'version',
        await runCheck(() => checkVersion(dir, version, entries, entriesError), 'version could not be verified')
      );
      if (!signature.ok) record('install', fail('not run'));
      else if (options.skipInstall) record('install', { ok: true, reason: 'skipped' });
      else record('install', await runCheck(() => checkInstall(dir, version), 'install could not be verified'));
    } finally {
      await cleanTemp(work);
    }
  }
  const ok = checks.every((check) => check.ok);
  if (options.json)
    process.stdout.write(
      `${JSON.stringify({ ok, version, ...(signersOverride ? { signersOverride: true } : {}), ...(notes.length ? { notes } : {}), checks })}\n`
    );
  else {
    if (signersOverride) process.stdout.write('NOTE allowed_signers overridden by BRAINATLAS_RELEASE_VERIFY_SIGNERS\n');
    for (const note of notes) process.stdout.write(`NOTE ${escape(note)}\n`);
    for (const check of checks)
      process.stdout.write(`${check.ok ? 'PASS' : 'FAIL'} ${check.id}${check.reason ? `: ${check.reason}` : ''}\n`);
  }
  if (!ok) process.exitCode = 1;
}

async function runCheck(run, fallback) {
  try {
    return await run();
  } catch {
    return fail(fallback);
  }
}

await main();
