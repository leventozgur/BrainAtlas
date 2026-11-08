// SPDX-License-Identifier: MIT
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { BrainAtlasError, atomicWriteFile } from '../../../packages/core/src/util/index.mjs';
import { SyncTransportError, ConflictError, validateTransportPath } from '../../sync-engine/src/transport.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const ignoredName = (name) => name.endsWith('.icloud') || name.startsWith('~$') || name.endsWith('.tmp') || name.startsWith('.syncthing.');
const extensionOf = (name) => name.toLowerCase().endsWith('.md') ? '.md' : '';

/** Recognize provider-generated sibling copies without treating ordinary files as conflicts. */
export function isFolderConflictCopy(path) {
  const name = basename(path);
  const extension = extensionOf(name);
  const stem = extension ? name.slice(0, -extension.length) : name;
  return / \d+$/.test(stem)
    || / \(conflicted copy(?: [^)]*)?\)$/i.test(stem)
    || / \([^)]*çakışan kopya[^)]*\)$/i.test(stem)
    || / \(\d+\)$/.test(stem)
    // OneDrive appends the device name after the final dash. Require an
    // uppercase/digit host token of at least three characters so ordinary
    // kebab-case names (for example, "meeting-notes") are not conflicts.
    || /-[A-Z0-9]{3,}$/.test(stem)
    || /\.sync-conflict-\d{8}-\d{6}-[A-Z0-9]{7}$/i.test(stem);
}

function within(base, candidate) {
  const from = relative(base, candidate);
  return from === '' || (from !== '..' && !from.startsWith(`..${sep}`) && !isAbsolute(from));
}

async function canonicalCandidate(path) {
  const absolute = resolve(path);
  let current = absolute;
  const missing = [];
  while (true) {
    try {
      const actual = await realpath(current);
      return resolve(actual, ...missing.reverse());
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      missing.push(current.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
      current = parent;
    }
  }
}

async function validateRoot(path, vaultPath) {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0') || typeof vaultPath !== 'string' || !isAbsolute(vaultPath)) {
    throw new SyncTransportError('E_INVALID_PATH');
  }
  const [root, vault] = await Promise.all([canonicalCandidate(path), canonicalCandidate(vaultPath)]);
  if (within(vault, root)) throw new SyncTransportError('E_INVALID_PATH');
  // A user may intentionally configure a symlink as the transport root.
  // Use its canonical target for subsequent path checks and filesystem work.
  return root;
}

function revision(bytes, mtimeMs) { return `${sha256(bytes)}:${mtimeMs}`; }

function validatePrefix(prefix) {
  if (prefix === '') return;
  const clean = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  validateTransportPath(clean);
  if (prefix.includes('//')) throw new SyncTransportError('E_INVALID_PATH');
}

function safeTarget(root, path) {
  validateTransportPath(path);
  return join(root, ...path.split('/'));
}

async function ensureNoSymlinkPath(root, path, { includeLeaf = true } = {}) {
  const parts = path.split('/');
  let current = root;
  const count = includeLeaf ? parts.length : parts.length - 1;
  for (const part of parts.slice(0, count)) {
    current = join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new SyncTransportError('E_INVALID_PATH');
      if (current !== join(root, ...parts) && !info.isDirectory()) throw new SyncTransportError('E_INVALID_PATH');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      break;
    }
  }
}

async function scanFiles(root, current = root, rows = []) {
  let entries;
  try { entries = await readdir(current, { withFileTypes: true }); }
  catch (error) { if (error?.code === 'ENOENT') return rows; throw error; }
  for (const entry of entries) {
    if (ignoredName(entry.name) || entry.isSymbolicLink()) continue;
    const absolute = join(current, entry.name);
    if (entry.isDirectory()) await scanFiles(root, absolute, rows);
    else if (entry.isFile()) {
      const path = relative(root, absolute).split(sep).join('/');
      try { validateTransportPath(path); } catch { continue; }
      const info = await lstat(absolute);
      if (!info.isFile() || info.isSymbolicLink()) continue;
      const bytes = await readFile(absolute);
      rows.push({ path, rev: revision(bytes, info.mtimeMs), size: bytes.byteLength, conflict: isFolderConflictCopy(path) });
    }
  }
  return rows;
}

/**
 * Local-folder object storage for folders synchronized by an external client.
 * Revisions include content digest and mtime. Conditional writes are best effort;
 * this transport intentionally makes no cross-process CAS guarantee.
 * @param {{path:string,vaultPath:string}} options
 */
export function createFolderTransport({ path, vaultPath, atomicWriter = atomicWriteFile } = {}) {
  if (typeof path !== 'string' || typeof vaultPath !== 'string') throw new BrainAtlasError('E_MODULE_CONTEXT', 'Folder transport paths are incomplete.');
  const initialization = validateRoot(path, vaultPath).then(async (validated) => {
    await mkdir(validated, { recursive: true });
    const info = await lstat(validated);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new SyncTransportError('E_INVALID_PATH');
    const [actualRoot, actualVault] = await Promise.all([realpath(validated), realpath(vaultPath)]);
    if (within(actualVault, actualRoot)) throw new SyncTransportError('E_INVALID_PATH');
    return actualRoot;
  });
  const readyRoot = () => initialization;
  const capabilities = Object.freeze({ cas: false, mode: 'object' });

  async function listObjects(prefix = '') {
    validatePrefix(prefix);
    const base = await readyRoot();
    const rows = await scanFiles(base);
    return rows.filter((row) => row.path.startsWith(prefix)).sort((a, b) => a.path.localeCompare(b.path));
  }

  async function getObject(path) {
    const base = await readyRoot();
    const target = safeTarget(base, path);
    await ensureNoSymlinkPath(base, path);
    try {
      const [bytes, info] = await Promise.all([readFile(target), lstat(target)]);
      if (!info.isFile() || info.isSymbolicLink()) throw new SyncTransportError('E_INVALID_PATH');
      return { bytes: Uint8Array.from(bytes), rev: revision(bytes, info.mtimeMs) };
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }

  return Object.freeze({
    capabilities,
    list: listObjects,
    get: getObject,
    async put(path, bytes, options = {}) {
      if (!(bytes instanceof Uint8Array)) throw new TypeError('Transport bytes must be a Uint8Array.');
      if (options.ifRev !== undefined && (typeof options.ifRev !== 'string' || !options.ifRev)) throw new ConflictError();
      if (options.ifAbsent === true && options.ifRev !== undefined) throw new ConflictError();
      const base = await readyRoot();
      const target = safeTarget(base, path);
      await ensureNoSymlinkPath(base, path, { includeLeaf: false });
      const current = await (async () => {
        try {
          const [currentBytes, info] = await Promise.all([readFile(target), lstat(target)]);
          if (!info.isFile() || info.isSymbolicLink()) throw new SyncTransportError('E_INVALID_PATH');
          return { rev: revision(currentBytes, info.mtimeMs) };
        } catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
      })();
      if ((options.ifAbsent && current) || (options.ifRev !== undefined && (!current || current.rev !== options.ifRev))
          || (options.ifAbsent !== true && options.ifRev === undefined && current)) throw new ConflictError();
      await mkdir(dirname(target), { recursive: true });
      await ensureNoSymlinkPath(base, path, { includeLeaf: false });
      // Recheck immediately before replacement; filesystem sync clients do not provide atomic CAS.
      const beforeWrite = await (async () => {
        try {
          const [currentBytes, info] = await Promise.all([readFile(target), lstat(target)]);
          if (!info.isFile() || info.isSymbolicLink()) throw new SyncTransportError('E_INVALID_PATH');
          return { rev: revision(currentBytes, info.mtimeMs) };
        } catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
      })();
      if ((options.ifAbsent && beforeWrite) || (options.ifRev !== undefined && (!beforeWrite || beforeWrite.rev !== options.ifRev))
          || (options.ifAbsent !== true && options.ifRev === undefined && beforeWrite)) throw new ConflictError();
      await atomicWriter(target, bytes, { tempPrefix: '.brainatlas-tmp-' });
      const stored = await getObject(path);
      if (!stored) throw new SyncTransportError('E_DEGRADED');
      return { rev: stored.rev };
    },
    async delete(path, options = {}) {
      if (typeof options.ifRev !== 'string' || !options.ifRev) throw new ConflictError();
      const base = await readyRoot();
      const target = safeTarget(base, path);
      await ensureNoSymlinkPath(base, path);
      let current;
      try {
        const [bytes, info] = await Promise.all([readFile(target), lstat(target)]);
        current = { rev: revision(bytes, info.mtimeMs) };
      } catch (error) { if (error?.code === 'ENOENT') throw new SyncTransportError('E_NOT_FOUND'); throw error; }
      if (current.rev !== options.ifRev) throw new ConflictError();
      await unlink(target);
    },
    /** Provider copies and lack of CAS make this transport degraded by design. */
    async status() {
      const rows = await listObjects();
      const conflicts = rows.filter((row) => row.conflict).map(({ path }) => path);
      return { status: 'degraded', code: 'E_DEGRADED', cas: false, conflictCount: conflicts.length, conflicts };
    },
  });
}

/** Attach the local-folder transport only when selected in configuration. */
export async function activate(ctx) {
  if (!ctx || typeof ctx !== 'object' || !ctx.config || !ctx.paths) throw new BrainAtlasError('E_MODULE_CONTEXT', 'Folder module context is incomplete.');
  if (ctx.config.sync?.transport !== 'folder' || ctx.transport) return;
  ctx.transport = createFolderTransport({ path: ctx.config.sync?.options?.path, vaultPath: ctx.config.vault?.path });
}

export const commands = Object.freeze({});
