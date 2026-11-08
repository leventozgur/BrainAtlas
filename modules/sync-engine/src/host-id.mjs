// SPDX-License-Identifier: MIT
import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, link, lstat, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { BrainAtlasError } from '../../../packages/core/src/util/errors.mjs';

const invalidState = () => new BrainAtlasError('E_STATE_INVALID', 'Sync host identity state is invalid.');

function normalizeHostId(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw invalidState();
  const trimmed = value.trim();
  if (!trimmed) return null;
  const normalized = trimmed.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/g, '');
  if (!normalized) throw invalidState();
  return normalized;
}

async function readStoredHostId(path) {
  let info;
  try { info = await lstat(path); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw invalidState(); }
  if (!info.isFile() || info.isSymbolicLink()) throw invalidState();
  try {
    if ((info.mode & 0o777) !== 0o600) await chmod(path, 0o600);
    const value = (await readFile(path, 'utf8')).trim();
    if (!/^[a-z0-9-]{1,32}$/.test(value)) throw invalidState();
    return value;
  } catch (error) {
    if (error instanceof BrainAtlasError) throw error;
    throw invalidState();
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

  const syncDir = join(resolve(stateDir), 'sync');
  const hostIdPath = join(syncDir, 'host-id');
  await mkdir(syncDir, { recursive: true, mode: 0o700 }).catch(() => { throw invalidState(); });
  const existing = await readStoredHostId(hostIdPath);
  if (existing) return existing;

  const generated = randomBytes(16).toString('hex');
  const temporaryPath = join(syncDir, `.host-id-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(`${generated}\n`);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporaryPath, 0o600);
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
