// SPDX-License-Identifier: MIT
// Self-contained installer helper. This file is copied unchanged into release kits.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, mkdir, writeFile, rm, lstat, rename, symlink } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

const fail = (code, message) => Object.assign(new Error(message), { code });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const safeVersion = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) && value !== '..';

function readTar(buffer) {
  const files = new Map(); let ended = false;
  for (let offset = 0; offset + 512 <= buffer.length;) {
    const header = buffer.subarray(offset, offset + 512); offset += 512;
    if (header.every(byte => byte === 0)) { ended = true; break; }
    const field = (start, length) => header.subarray(start, start + length).toString('utf8').split('\0')[0];
    const storedChecksum = Number.parseInt(field(148, 8).trim(), 8);
    const checkHeader = Buffer.from(header); checkHeader.fill(32, 148, 156);
    const sizeText = field(124, 12).trim();
    const size = /^[0-7]+$/.test(sizeText) ? Number.parseInt(sizeText, 8) : NaN;
    const name = [field(345, 155), field(0, 100)].filter(Boolean).join('/');
    const type = field(156, 1) || '\0';
    const parts = name.split('/');
    if (storedChecksum !== checkHeader.reduce((sum, byte) => sum + byte, 0) || !Number.isSafeInteger(size) || size < 0 || offset + size > buffer.length || !name || name.startsWith('/') || name.includes('\\') || parts.some(part => !part || part === '.' || part === '..') || !['0', '\0'].includes(type) || files.has(name)) {
      throw fail('E_MANIFEST_INVALID', 'Invalid release archive entry.');
    }
    files.set(name, buffer.subarray(offset, offset + size));
    offset += Math.ceil(size / 512) * 512;
  }
  if (!ended) throw fail('E_MANIFEST_INVALID', 'Release archive is truncated.');
  return files;
}

/** Verify checksums, signature, and the manifest before exposing archive entries. */
export async function inspectReleaseArchive(archivePath, allowedSigners) {
  let archive; let sums;
  const sumsPath = join(dirname(archivePath), 'SHA256SUMS');
  const signaturePath = `${sumsPath}.sig`;
  try { [archive, sums] = await Promise.all([readFile(archivePath), readFile(sumsPath)]); }
  catch { throw fail('E_ARCHIVE_READ', 'Release archive or checksum file is unavailable.'); }
  const archiveName = basename(archivePath);
  const matching = sums.toString('utf8').split('\n').filter(line => line.endsWith(`  ${archiveName}`));
  if (matching.length !== 1 || matching[0] !== `${hash(archive)}  ${archiveName}`) throw fail('E_SHA_MISMATCH', 'Release archive checksum mismatch.');
  const signerFile = allowedSigners || join(dirname(fileURLToPath(import.meta.url)), 'allowed_signers');
  if (process.env.BRAINATLAS_INSECURE_SKIP_SIGNATURE !== '1') {
    try {
      execFileSync('ssh-keygen', ['-Y', 'verify', '-f', signerFile, '-I', 'brainatlas-release', '-n', 'brainatlas-release', '-s', signaturePath], { input: sums, stdio: ['pipe', 'ignore', 'ignore'] });
    } catch { throw fail('E_SIGNATURE_INVALID', 'Release signature is invalid.'); }
  }
  let files;
  try { files = readTar(gunzipSync(archive)); }
  catch (error) { if (error?.code === 'E_MANIFEST_INVALID') throw error; throw fail('E_MANIFEST_INVALID', 'Release archive is invalid.'); }
  const manifests = [...files.keys()].filter(name => /^[^/]+\/release-manifest\.json$/.test(name));
  if (manifests.length !== 1) throw fail('E_MANIFEST_INVALID', 'Release manifest is missing.');
  const manifestName = manifests[0]; let manifest;
  try { manifest = JSON.parse(files.get(manifestName).toString('utf8')); } catch { throw fail('E_MANIFEST_INVALID', 'Release manifest is invalid.'); }
  const prefix = `brainatlas-${manifest?.version}/`;
  if (!safeVersion(manifest?.version) || manifest?.name !== 'brainatlas' || !['lite', 'full'].includes(manifest?.profile) || !Array.isArray(manifest?.modules) || !Array.isArray(manifest?.files) || manifestName !== `${prefix}release-manifest.json` || archiveName !== `brainatlas-${manifest.version}-${manifest.profile}.tgz`) {
    throw fail('E_MANIFEST_INVALID', 'Release manifest is invalid.');
  }
  const expected = new Set([manifestName]);
  for (const entry of manifest.files) {
    if (!entry || typeof entry.path !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256) || entry.path.startsWith('/') || entry.path.includes('\\') || entry.path.split('/').some(part => !part || part === '.' || part === '..')) throw fail('E_MANIFEST_INVALID', 'Release inventory is invalid.');
    const archiveEntry = prefix + entry.path;
    if (expected.has(archiveEntry)) throw fail('E_MANIFEST_INVALID', 'Release inventory contains duplicates.');
    expected.add(archiveEntry);
    const content = files.get(archiveEntry);
    if (!content || hash(content) !== entry.sha256) throw fail('E_SHA_MISMATCH', 'Release inventory checksum mismatch.');
  }
  if (files.size !== expected.size || [...files.keys()].some(name => !expected.has(name))) throw fail('E_MANIFEST_INVALID', 'Release archive has unexpected entries.');
  if (manifest.profile === 'lite' && [...files.keys()].some(name => name.startsWith(`${prefix}modules/`))) throw fail('E_PROFILE_MISMATCH', 'Lite release contains modules.');
  return { manifest, files, prefix };
}

/** Extract a verified release into a new destination directory. */
export async function extractVerifiedRelease(archivePath, destination, allowedSigners) {
  const { manifest, files, prefix } = await inspectReleaseArchive(archivePath, allowedSigners);
  const root = resolve(destination);
  await mkdir(root);
  try {
    for (const [name, bytes] of files) {
      const relative = name.slice(prefix.length);
      const target = resolve(root, relative);
      if (!target.startsWith(`${root}${sep}`)) throw fail('E_MANIFEST_INVALID', 'Release path escapes destination.');
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes, { flag: 'wx', mode: 0o644 });
    }
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
  return manifest;
}

const args = process.argv.slice(2);
const value = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };

async function main() {
  if (args.includes('--switch-link')) {
    const link = value('--link'); const target = value('--target');
    if (!link || !/^releases\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(target || '')) throw fail('E_ARGUMENT', 'Invalid release switch request.');
    const destination = resolve(link); const temp = `${destination}.next-${process.pid}`;
    try { const stat = await lstat(destination); if (!stat.isSymbolicLink()) throw fail('E_PATH_CONFLICT', 'Current release path is not a symbolic link.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await rm(temp, { force: true }); await symlink(target, temp);
    try { await rename(temp, destination); }
    catch { await rm(temp, { force: true }); throw fail('E_CURRENT_SWITCH', 'Could not switch current release.'); }
    return;
  }
  if (args.includes('--write-shim')) {
    const file = value('--file'); const node = value('--node'); const cli = value('--cli');
    if (!file || !node || !cli) throw fail('E_ARGUMENT', 'Invalid command shim request.');
    const quote = item => `'${item.replace(/'/g, `'\\''`)}'`;
    await mkdir(dirname(resolve(file)), { recursive: true });
    await writeFile(resolve(file), `#!/bin/sh\nexec ${quote(resolve(node))} ${quote(resolve(cli))} "$@"\n`, { mode: 0o755 });
    return;
  }
  const archive = value('--archive'); const destination = value('--destination'); const signers = value('--allowed-signers');
  if (!archive || !destination || !signers) throw fail('E_ARGUMENT', 'Archive, destination, and trusted signers are required.');
  const manifest = await extractVerifiedRelease(resolve(archive), resolve(destination), resolve(signers));
  process.stdout.write(`${manifest.version} ${manifest.profile}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await main(); }
  catch (error) {
    const safeCodes = new Set(['E_ARGUMENT', 'E_ARCHIVE_READ', 'E_SHA_MISMATCH', 'E_SIGNATURE_INVALID', 'E_MANIFEST_INVALID', 'E_PROFILE_MISMATCH', 'E_PATH_CONFLICT', 'E_CURRENT_SWITCH']);
    const code = safeCodes.has(error?.code) ? error.code : 'E_INSTALL';
    const message = safeCodes.has(error?.code) ? error.message : 'Install helper could not complete the requested operation.';
    console.error(`${code}: ${message}`);
    process.exitCode = 1;
  }
}
