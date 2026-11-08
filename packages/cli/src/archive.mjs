// SPDX-License-Identifier: MIT
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
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

/** Verify the checksum, OpenSSH signature and manifest inventory before returning archive entries. */
export async function inspectReleaseArchive(archivePath, allowedSigners) {
  let archive; let sums;
  const sumsPath = join(dirname(archivePath), 'SHA256SUMS');
  const signaturePath = `${sumsPath}.sig`;
  try { [archive, sums] = await Promise.all([readFile(archivePath), readFile(sumsPath)]); }
  catch { throw fail('E_ARCHIVE_READ', 'Release archive or checksum file is unavailable.'); }
  const archiveName = basename(archivePath);
  const matching = sums.toString('utf8').split('\n').filter(line => line.endsWith(`  ${archiveName}`));
  if (matching.length !== 1 || matching[0] !== `${hash(archive)}  ${archiveName}`) throw fail('E_SHA_MISMATCH', 'Release archive checksum mismatch.');
  const signerFile = allowedSigners || resolve(dirname(fileURLToPath(import.meta.url)), '../../../release/allowed_signers');
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

/** Extract a previously verified release into a new directory. */
export async function extractVerifiedRelease(archivePath, destination, allowedSigners) {
  const { manifest, files, prefix } = await inspectReleaseArchive(archivePath, allowedSigners);
  const root = resolve(destination);
  await mkdir(root);
  try {
    for (const [name, bytes] of files) {
      const relative = name.slice(prefix.length);
      const target = resolve(root, relative);
      if (!target.startsWith(`${root}${sep}`)) throw fail('E_MANIFEST_INVALID', 'Release path escapes destination.');
      const parent = dirname(target);
      await mkdir(parent, { recursive: true });
      await writeFile(target, bytes, { flag: 'wx', mode: 0o644 });
    }
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
  return manifest;
}
