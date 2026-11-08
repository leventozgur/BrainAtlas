// SPDX-License-Identifier: MIT
import { randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, realpath, stat, unlink } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { BrainAtlasError } from '../../../packages/core/src/util/errors.mjs';

const invalidState = () => new BrainAtlasError('E_STATE_INVALID', 'Sync host identity state is invalid.');
const invalidPath = () => new BrainAtlasError('E_INVALID_PATH', 'Sync host identity path is invalid.');

function normalizeHostId(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw invalidState();
  const trimmed = value.trim();
  if (!trimmed) return null;
  const normalized = trimmed.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/g, '');
  if (!normalized) throw invalidState();
  return normalized;
}

function isWithin(root, path) {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

async function ensureStateRoot(path) {
  try { await lstat(path); }
  catch (error) {
    if (error?.code !== 'ENOENT') throw invalidState();
    try { await mkdir(path, { recursive: true, mode: 0o700 }); }
    catch { throw invalidState(); }
  }

  let root;
  try { root = await realpath(path); }
  catch { throw invalidState(); }
  try {
    const info = await stat(root);
    if (!info.isDirectory()) throw invalidPath();
  } catch (error) {
    if (error instanceof BrainAtlasError) throw error;
    throw invalidState();
  }
  return root;
}

async function ensureSyncDirectory(path, stateRoot) {
  let info;
  try { info = await lstat(path); }
  catch (error) {
    if (error?.code !== 'ENOENT') throw invalidState();
    try { await mkdir(path, { mode: 0o700 }); }
    catch (createError) {
      if (createError?.code !== 'EEXIST') throw invalidState();
    }
    try { info = await lstat(path); }
    catch { throw invalidState(); }
  }

  if (!info.isDirectory() || info.isSymbolicLink()) throw invalidPath();
  let actual;
  try { actual = await realpath(path); }
  catch { throw invalidState(); }
  if (!isWithin(stateRoot, actual)) throw invalidPath();
  return actual;
}

async function readStoredHostId(path) {
  let info;
  try { info = await lstat(path); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw invalidState(); }
  if (!info.isFile() || info.isSymbolicLink()) throw invalidPath();
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    info = await handle.stat();
    if (!info.isFile()) throw invalidPath();
    if ((info.mode & 0o777) !== 0o600) await handle.chmod(0o600);
    const value = (await handle.readFile('utf8')).trim();
    if (!/^[a-z0-9-]{1,32}$/.test(value)) throw invalidState();
    return value;
  } catch (error) {
    if (error instanceof BrainAtlasError) throw error;
    if (error?.code === 'ENOENT') return null;
    if (error?.code === 'ELOOP' || error?.code === 'EMLINK') throw invalidPath();
    throw invalidState();
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** Resolve a configured sync host identity or create one private to this state directory. */
export async function resolveHostId({ stateDir, env = {}, config = {}, hostId: legacyHostId } = {}) {
  if (typeof stateDir !== 'string' || !stateDir) throw invalidState();
  const fromEnvironment = normalizeHostId(env?.BRAINATLAS_HOST_ID);
  if (fromEnvironment) return fromEnvironment;
  const fromConfig = normalizeHostId(config?.sync?.options?.hostId);
  if (fromConfig) return fromConfig;
  // Keep the old constructor option working for callers that have not moved to env/config yet.
  const fromLegacyOption = normalizeHostId(legacyHostId);
  if (fromLegacyOption) return fromLegacyOption;

  const statePath = resolve(stateDir);
  const syncDir = join(statePath, 'sync');
  const hostIdPath = join(syncDir, 'host-id');
  const stateRoot = await ensureStateRoot(statePath);
  await ensureSyncDirectory(syncDir, stateRoot);
  const existing = await readStoredHostId(hostIdPath);
  if (existing) return existing;

  const generated = randomBytes(16).toString('hex');
  const temporaryPath = join(syncDir, `.host-id-${randomUUID()}.tmp`);
  let handle;
  try {
    await ensureSyncDirectory(syncDir, stateRoot);
    handle = await open(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    await handle.writeFile(`${generated}\n`);
    await handle.chmod(0o600);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await ensureSyncDirectory(syncDir, stateRoot);
    try {
      await link(temporaryPath, hostIdPath);
      return generated;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const raced = await readStoredHostId(hostIdPath);
      if (!raced) throw invalidState();
      return raced;
    }
  } catch (error) {
    if (error instanceof BrainAtlasError) throw error;
    throw invalidState();
  } finally {
    await handle?.close().catch(() => {});
    await unlink(temporaryPath).catch(() => {});
  }
}
