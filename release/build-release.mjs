// SPDX-License-Identifier: MIT
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, readdir, mkdir, writeFile, lstat, rm, rename, cp } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hash = b => createHash('sha256').update(b).digest('hex');
const fail = (code, message) => Object.assign(new Error(message), { code });
const safe = s => typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s) && s !== '..';

async function atomicWrite(path, bytes, mode = 0o644) {
  const temp = `${path}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  try {
    await writeFile(temp, bytes, { flag: 'wx', mode });
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

async function walk(base, rel = '') {
  const path = join(base, rel); let stat;
  try { stat = await lstat(path); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  if (stat.isSymbolicLink()) throw fail('E_MANIFEST_INVALID', 'Unexpected symbolic link in release input.');
  if (stat.isDirectory()) {
    const names = (await readdir(path)).sort();
    return (await Promise.all(names.map(n => walk(base, rel ? `${rel}/${n}` : n)))).flat();
  }
  if (!stat.isFile()) throw fail('E_MANIFEST_INVALID', 'Unsupported release input.');
  return [{ path: rel, data: await readFile(path), mode: stat.mode & 0o111 ? 0o755 : 0o644 }];
}
function tar(entries) {
  const parts = [];
  for (const entry of entries) {
    const h = Buffer.alloc(512); const name = entry.path;
    let prefix = ''; let short = name;
    if (Buffer.byteLength(short) > 100) { const i = name.lastIndexOf('/', 155); prefix = name.slice(0, i); short = name.slice(i + 1); }
    if (Buffer.byteLength(short) > 100 || Buffer.byteLength(prefix) > 155 || !short) throw fail('E_MANIFEST_INVALID', 'Archive path is too long.');
    h.write(short, 0, 100); h.write(prefix, 345, 155);
    const oct = (n, off, len) => h.write(n.toString(8).padStart(len - 1, '0') + '\0', off, len);
    oct(entry.mode, 100, 8); oct(0, 108, 8); oct(0, 116, 8); oct(entry.data.length, 124, 12); oct(0, 136, 12);
    h.fill(32, 148, 156); h.write('0', 156); h.write('ustar\0', 257); h.write('00', 263);
    const sum = h.reduce((a, b) => a + b, 0); h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
    parts.push(h, entry.data, Buffer.alloc((512 - entry.data.length % 512) % 512));
  }
  return Buffer.concat([...parts, Buffer.alloc(1024)]);
}
function untar(buf) {
  const result = new Map(); let end = false;
  for (let offset = 0; offset + 512 <= buf.length;) {
    const h = buf.subarray(offset, offset + 512); offset += 512;
    if (h.every(x => x === 0)) { end = true; break; }
    const field = (a, n) => h.subarray(a, a + n).toString().split('\0')[0];
    const stored = parseInt(field(148, 8).trim(), 8); const copy = Buffer.from(h); copy.fill(32, 148, 156);
    const sizeText = field(124, 12).trim(); const size = /^[0-7]+$/.test(sizeText) ? parseInt(sizeText, 8) : NaN;
    const name = [field(345, 155), field(0, 100)].filter(Boolean).join('/');
    if (stored !== copy.reduce((a, b) => a + b, 0) || !Number.isSafeInteger(size) || offset + size > buf.length || !name || name.startsWith('/') || name.split('/').some(p => !p || p === '.' || p === '..') || !['0', '\0'].includes(field(156, 1) || '\0') || result.has(name)) throw fail('E_MANIFEST_INVALID', 'Invalid archive entry.');
    result.set(name, buf.subarray(offset, offset + size)); offset += Math.ceil(size / 512) * 512;
  }
  if (!end) throw fail('E_MANIFEST_INVALID', 'Truncated archive.');
  return result;
}

/** @param {{version:string,profile:'lite'|'full',modules:string[],builtAt:string,out?:string}} options @returns {Promise<string[]>} */
export async function buildRelease(options) {
  const { version, profile, builtAt = '1970-01-01T00:00:00.000Z', out = root } = options || {};
  const sourceRoot = resolve(process.env.BRAINATLAS_RELEASE_SOURCE || root);
  if (!safe(version) || !['lite', 'full'].includes(profile) || typeof builtAt !== 'string') throw fail('E_MANIFEST_INVALID', 'Invalid release options.');
  const roots = ['package.json', 'packages/core', 'packages/mcp', 'packages/hooks', 'packages/cli', 'packages/adapters', 'vendor', 'templates', 'release/allowed_signers'];
  let files = (await Promise.all(roots.map(p => walk(sourceRoot, p)))).flat();
  const modules = [];
  if (profile === 'full') {
    let moduleNames = [];
    try { moduleNames = await readdir(join(sourceRoot, 'modules')); } catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
    for (const name of moduleNames.sort()) {
      const entries = await walk(sourceRoot, `modules/${name}`);
      if (!entries.some(f => f.path === `modules/${name}/module.json`)) {
        console.warn(`Skipping module without manifest: ${name}`);
        continue;
      }
      modules.push(name); files.push(...entries);
    }
  }
  const lock = JSON.parse(await readFile(join(sourceRoot, 'package-lock.json'), 'utf8'));
  const queue = files.filter(f => f.path.endsWith('/package.json')).map(f => JSON.parse(f.data).dependencies || {});
  const seen = new Set();
  while (queue.length) for (const name of Object.keys(queue.shift())) {
    if (seen.has(name)) continue; seen.add(name);
    const info = lock.packages[`node_modules/${name}`];
    if (!info) throw fail('E_MANIFEST_INVALID', 'A production dependency is absent from the lockfile.');
    if (info.link) {
      const target = info.resolved;
      if (!target || target.startsWith('/') || target.split('/').includes('..')) throw fail('E_MANIFEST_INVALID', 'Invalid workspace dependency.');
      const entries = await walk(sourceRoot, target);
      if (!entries.length) throw fail('E_MANIFEST_INVALID', 'Workspace dependency is missing.');
      files.push(...entries.map(f => ({ ...f, path: `node_modules/${name}/${f.path.slice(target.length + 1)}` })));
      const pkg = JSON.parse(await readFile(join(sourceRoot, target, 'package.json'))); queue.push(pkg.dependencies || {});
    } else {
      const entries = await walk(sourceRoot, `node_modules/${name}`);
      if (!entries.length) throw fail('E_MANIFEST_INVALID', 'A production dependency is not installed.');
      files.push(...entries); queue.push(info.dependencies || {});
    }
  }
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const forbidden = /modules\/sync-|keychain|secret-service|launchd|systemd|dropbox/i;
  if (profile === 'lite') {
    if (files.filter(f => /^(packages\/|vendor\/llmwiki-core\/|templates\/)/.test(f.path)).some(f => forbidden.test(f.path) || forbidden.test(f.data.toString('utf8')))) throw fail('E_LITE_PURITY', 'Lite release contains forbidden content.');
  }
  const manifest = { name: 'brainatlas', version, profile, modules, files: files.map(f => ({ path: f.path, sha256: hash(f.data) })), builtAt };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  if (profile === 'lite' && forbidden.test(manifestBytes.toString('utf8'))) throw fail('E_LITE_PURITY', 'Lite release contains forbidden content.');
  files.push({ path: 'release-manifest.json', data: manifestBytes, mode: 0o644 });
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const archive = gzipSync(tar(files.map(f => ({ ...f, path: `brainatlas-${version}/${f.path}` }))), { level: 9, mtime: 0 });
  await mkdir(out, { recursive: true }); const name = `brainatlas-${version}-${profile}.tgz`; const dest = join(out, name);
  await atomicWrite(dest, archive);
  const sumsPath = join(out, 'SHA256SUMS'); let lines = [];
  try { lines = (await readFile(sumsPath, 'utf8')).split('\n').filter(line => line && !line.endsWith(`  ${name}`)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  lines.push(`${hash(archive)}  ${name}`); lines.sort(); await atomicWrite(sumsPath, `${lines.join('\n')}\n`);
  return [dest, sumsPath];
}

/** Build a self-contained offline distribution directory for both release profiles. */
export async function buildDistribution(options = {}) {
  const sourceRoot = resolve(process.env.BRAINATLAS_RELEASE_SOURCE || root);
  const packageInfo = JSON.parse(await readFile(join(sourceRoot, 'package.json'), 'utf8'));
  const version = options.version ?? packageInfo.version;
  const builtAt = options.builtAt ?? '1970-01-01T00:00:00.000Z';
  const out = resolve(options.out || join(root, 'release', 'dist'));
  if (!safe(version) || typeof builtAt !== 'string') throw fail('E_MANIFEST_INVALID', 'Invalid release options.');

  const parent = dirname(out);
  await mkdir(parent, { recursive: true });
  const stage = join(parent, `.${basename(out)}.staging-${process.pid}-${randomBytes(6).toString('hex')}`);
  const backup = `${out}.previous-${process.pid}-${randomBytes(6).toString('hex')}`;
  await mkdir(stage);
  let movedPrevious = false;
  try {
    for (const profile of ['lite', 'full']) await buildRelease({ version, profile, builtAt, out: stage });
    await mkdir(join(stage, 'release'));
    await cp(join(sourceRoot, 'install.sh'), join(stage, 'install.sh'));
    await cp(join(sourceRoot, 'release', 'install-kit.mjs'), join(stage, 'release', 'install-kit.mjs'));
    await cp(join(sourceRoot, 'release', 'allowed_signers'), join(stage, 'release', 'allowed_signers'));

    const names = (await readdir(stage, { withFileTypes: true }))
      .filter(entry => entry.isFile() && entry.name !== 'SHA256SUMS' && entry.name !== 'SHA256SUMS.sig')
      .map(entry => entry.name);
    names.push('release/install-kit.mjs', 'release/allowed_signers');
    const lines = [];
    for (const name of [...new Set(names)].sort()) {
      const bytes = await readFile(join(stage, name));
      lines.push(`${hash(bytes)}  ${name}`);
    }
    await atomicWrite(join(stage, 'SHA256SUMS'), `${lines.join('\n')}\n`);

    try { await lstat(out); await rename(out, backup); movedPrevious = true; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { await rename(stage, out); }
    catch (error) {
      if (movedPrevious) { await rename(backup, out); movedPrevious = false; }
      throw error;
    }
    if (movedPrevious) {
      movedPrevious = false;
      await rm(backup, { recursive: true, force: true }).catch(() => {});
    }
    return [join(out, `brainatlas-${version}-lite.tgz`), join(out, `brainatlas-${version}-full.tgz`), join(out, 'SHA256SUMS')];
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    if (movedPrevious) {
      try { await lstat(out); } catch (missing) { if (missing.code === 'ENOENT') await rename(backup, out); }
    }
    throw error;
  }
}

/** @param {string} archivePath @param {string} checksumPath @param {string} signaturePath @returns {Promise<object>} */
async function verifiedArchive(archivePath, checksumPath, signaturePath, allowedSigners = join(root, 'release/allowed_signers')) {
  const archive = await readFile(archivePath); const sums = await readFile(checksumPath);
  const matches = sums.toString().split('\n').filter(l => l.endsWith(`  ${basename(archivePath)}`));
  if (matches.length !== 1 || matches[0] !== `${hash(archive)}  ${basename(archivePath)}`) throw fail('E_SHA_MISMATCH', 'Archive checksum mismatch.');
  try { execFileSync('ssh-keygen', ['-Y', 'verify', '-f', allowedSigners, '-I', 'brainatlas-release', '-n', 'brainatlas-release', '-s', signaturePath], { input: sums, stdio: ['pipe', 'ignore', 'ignore'] }); } catch { throw fail('E_SIGNATURE_INVALID', 'Release signature is invalid.'); }
  let entries; try { entries = untar(gunzipSync(archive)); } catch (e) { if (e.code === 'E_MANIFEST_INVALID') throw e; throw fail('E_MANIFEST_INVALID', 'Invalid release archive.'); }
  const manifestNames = [...entries.keys()].filter(n => /^[^/]+\/release-manifest\.json$/.test(n));
  if (manifestNames.length !== 1) throw fail('E_MANIFEST_INVALID', 'Release manifest missing.');
  let manifest; try { manifest = JSON.parse(entries.get(manifestNames[0])); } catch { throw fail('E_MANIFEST_INVALID', 'Invalid release manifest.'); }
  const prefix = `brainatlas-${manifest.version}/`;
  if (!safe(manifest.version) || manifest.name !== 'brainatlas' || !['lite', 'full'].includes(manifest.profile) || !Array.isArray(manifest.modules) || !Array.isArray(manifest.files) || manifestNames[0] !== `${prefix}release-manifest.json` || basename(archivePath) !== `brainatlas-${manifest.version}-${manifest.profile}.tgz`) throw fail('E_MANIFEST_INVALID', 'Invalid release manifest.');
  const expected = new Set([manifestNames[0]]);
  for (const f of manifest.files) {
    if (!f || typeof f.path !== 'string' || !/^[a-f0-9]{64}$/.test(f.sha256) || expected.has(prefix + f.path)) throw fail('E_MANIFEST_INVALID', 'Invalid release inventory.');
    const name = prefix + f.path; expected.add(name); const bytes = entries.get(name);
    if (!bytes || hash(bytes) !== f.sha256) throw fail('E_SHA_MISMATCH', 'Release inventory checksum mismatch.');
  }
  if (entries.size !== expected.size || [...entries.keys()].some(n => !expected.has(n))) throw fail('E_MANIFEST_INVALID', 'Unexpected archive entry.');
  if (manifest.profile === 'lite' && [...entries.keys()].some(n => n.startsWith(`${prefix}modules/`))) throw fail('E_PROFILE_MISMATCH', 'Lite archive contains modules.');
  return { manifest, entries, prefix };
}
/** @param {string} archivePath @param {string} checksumPath @param {string} signaturePath @returns {Promise<object>} */
export async function verifyRelease(archivePath, checksumPath, signaturePath) {
  return (await verifiedArchive(archivePath, checksumPath, signaturePath, arguments[3])).manifest;
}

// Extract only verified regular files, into a newly created directory.
export async function extractRelease(archivePath, checksumPath, signaturePath, destination, allowedSigners) {
  const { manifest, entries, prefix } = await verifiedArchive(archivePath, checksumPath, signaturePath, allowedSigners);
  await mkdir(destination);
  try {
    for (const [name, bytes] of entries) {
      const target = join(destination, name.slice(prefix.length));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes, { flag: 'wx', mode: 0o644 });
    }
  } catch (e) { await rm(destination, { recursive: true, force: true }); throw e; }
  return manifest;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2); const get = key => { const index = args.indexOf(key); return index < 0 ? undefined : args[index + 1]; };
  try {
    if (get('--profile')) await buildRelease({ version: get('--version'), profile: get('--profile'), out: get('--out') });
    else await buildDistribution({ version: get('--version'), out: get('--out') });
  } catch (e) { console.error(`${e.code || 'E_RELEASE'}: ${e.message}`); process.exitCode = 1; }
}
