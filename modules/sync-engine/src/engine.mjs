// SPDX-License-Identifier: MIT
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm, stat, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { scanPath, scanText } from '../../../packages/core/src/safety/index.mjs';
import { BrainAtlasError } from '../../../packages/core/src/util/errors.mjs';
import { globMatch, inventoryVault, isLocalOnlyFrontmatter, resolveSyncScope } from './scope.mjs';
import { mergeCanonicalPath } from './merge.mjs';
import { SyncTransportError } from './transport.mjs';

const SPECIAL = new Set(['wiki/index.md', 'wiki/log.md']);
const MANIFEST_VERSION = 3;
const TOMBSTONE_PREFIX = '.brainatlas-sync/meta/tombstones/';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const asBytes = (value) => value instanceof Uint8Array ? Buffer.from(value) : Buffer.from(String(value));
const isMissing = (error) => error?.code === 'ENOENT';

export const SYNC_ERROR_CODES = Object.freeze(['E_AUTH', 'E_NETWORK', 'E_CONFLICT', 'E_QUOTA', 'E_NOT_FOUND', 'E_DEGRADED', 'E_INTERRUPTED', 'E_SECRET_DETECTED', 'E_INVALID_PATH', 'E_STATE_INVALID', 'E_TRANSPORT_UNAVAILABLE']);

export function classifySyncError(error) {
  if (SYNC_ERROR_CODES.includes(error?.code)) return error.code;
  if (['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE'].includes(error?.code)) return 'E_NETWORK';
  return null;
}

function safePath(path) {
  if (typeof path !== 'string' || !path || path.startsWith('/') || path.includes('\\') || path.includes('\0')
      || path.split('/').some((part) => !part || part === '.' || part === '..')) throw new SyncTransportError('E_INVALID_PATH');
  return path;
}

function conflictCopyPath(path, host, date, index = 0) {
  const directory = dirname(path) === '.' ? '' : `${dirname(path)}/`;
  const file = basename(path);
  const extension = file.endsWith('.md') ? '.md' : '';
  const stem = extension ? file.slice(0, -extension.length) : file;
  const stamp = date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const suffix = index ? `-${index}` : '';
  return `${directory}${stem}.conflict-${host}-${stamp}${suffix}${extension}`;
}

async function ensureDirectoryTree(root, directory) {
  const rel = relative(root, directory);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new SyncTransportError('E_INVALID_PATH');
  let current = root;
  for (const part of rel.split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new SyncTransportError('E_INVALID_PATH');
    } catch (error) {
      if (!isMissing(error)) throw error;
      await mkdir(current, { mode: 0o700 });
    }
  }
}

async function atomicWrite(target, bytes) {
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close(); handle = undefined;
    await rename(temporary, target);
  } catch (error) {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function readJson(file, fallback = null) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (isMissing(error)) return fallback; throw new SyncTransportError('E_STATE_INVALID'); }
}

function validManifest(value) {
  if (!value || value.version !== MANIFEST_VERSION || !Array.isArray(value.files)) return false;
  const paths = new Set();
  return value.files.every((row) => {
    const safe = row && typeof row.path === 'string' && row.path.length > 0 && !row.path.startsWith('/') && !row.path.includes('\\')
      && !row.path.includes('\0') && row.path.split('/').every((part) => part && part !== '.' && part !== '..')
      && !paths.has(row.path) && /^[a-f0-9]{64}$/.test(row.sha256) && Number.isSafeInteger(row.size) && row.size >= 0
      && Number.isFinite(row.mtime) && row.mtime >= 0 && (row.rev === null || (typeof row.rev === 'string' && row.rev.length > 0));
    if (safe) paths.add(row.path);
    return safe;
  });
}

function entry(path, bytes, mtime, rev) {
  return { path, sha256: sha256(bytes), size: bytes.byteLength, mtime, rev: rev ?? null };
}

function isSpecial(path) { return SPECIAL.has(path); }
function isConflictArtifact(path) { return /\.conflict-[a-z0-9_-]+-\d{8}T\d{6}Z(?:-\d+)?\.md$/i.test(path); }
function tombstonePath(path) { return `${TOMBSTONE_PREFIX}${Buffer.from(path).toString('base64url')}.json`; }

/**
 * Build a transport agnostic synchronizer. Each instance owns `stateDir/sync/`.
 * @param {{vaultPath:string,stateDir:string,config?:object,transport?:object,hostId?:string,now?:()=>Date,logger?:object}} options
 */
export function createSyncEngine({ vaultPath, stateDir, config = {}, transport, hostId = 'host', now = () => new Date(), logger = {} } = {}) {
  if (typeof vaultPath !== 'string' || typeof stateDir !== 'string') throw new SyncTransportError('E_STATE_INVALID');
  const unavailable = async () => { throw new SyncTransportError('E_TRANSPORT_UNAVAILABLE'); };
  const tx = transport ?? { list: unavailable, get: unavailable, put: unavailable, delete: unavailable };
  if (typeof tx.list !== 'function' || typeof tx.get !== 'function' || typeof tx.put !== 'function' || typeof tx.delete !== 'function') throw new SyncTransportError('E_TRANSPORT_UNAVAILABLE');
  const host = String(hostId).toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 32) || 'host';
  const root = resolve(vaultPath), syncDir = join(stateDir, 'sync');
  const manifestPath = join(syncDir, 'last-synced-manifest.json');
  const journalPath = join(syncDir, 'journal.json');
  const conflictsPath = join(syncDir, 'conflicts.json');
  const pendingDeletesPath = join(syncDir, 'pending-deletions.json');
  const settingsPath = join(syncDir, 'settings.json');
  const basesDir = join(syncDir, 'bases');
  const conflictDir = join(syncDir, 'conflicts');

  async function ensureState() { await mkdir(basesDir, { recursive: true, mode: 0o700 }); await mkdir(conflictDir, { recursive: true, mode: 0o700 }); }
  async function saveJson(path, value) { await atomicWrite(path, Buffer.from(`${JSON.stringify(value, null, 2)}\n`)); }
  async function readManifest() {
    const manifest = await readJson(manifestPath);
    if (manifest === null) return { version: MANIFEST_VERSION, generatedAt: null, files: [] };
    if (!validManifest(manifest)) throw new SyncTransportError('E_STATE_INVALID');
    return manifest;
  }
  async function safeLocalPath(path) {
    safePath(path);
    const target = resolve(root, path);
    const rel = relative(root, target);
    if (rel === '..' || rel.startsWith(`..${sep}`) || rel === '' || isAbsolute(rel)) throw new SyncTransportError('E_INVALID_PATH');
    let current = root;
    try {
      const rootInfo = await lstat(root);
      if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new SyncTransportError('E_INVALID_PATH');
    } catch (error) { if (!isMissing(error)) throw error; }
    const parts = path.split('/');
    for (const part of parts.slice(0, -1)) {
      current = join(current, part);
      try {
        const info = await lstat(current);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new SyncTransportError('E_INVALID_PATH');
      } catch (error) { if (isMissing(error)) break; throw error; }
    }
    try {
      const leaf = await lstat(target);
      if (!leaf.isFile() || leaf.isSymbolicLink()) throw new SyncTransportError('E_INVALID_PATH');
    } catch (error) { if (!isMissing(error)) throw error; }
    return target;
  }
  async function writeLocal(path, bytes) {
    const target = await safeLocalPath(path);
    await ensureDirectoryTree(root, dirname(target));
    try {
      const leaf = await lstat(target);
      if (!leaf.isFile() || leaf.isSymbolicLink()) throw new SyncTransportError('E_INVALID_PATH');
    } catch (error) { if (!isMissing(error)) throw error; }
    await atomicWrite(target, bytes);
    return await stat(target);
  }
  async function deleteLocal(path) {
    const target = await safeLocalPath(path);
    try {
      const info = await lstat(target);
      if (!info.isFile() || info.isSymbolicLink()) throw new SyncTransportError('E_INVALID_PATH');
      await unlink(target);
    } catch (error) { if (!isMissing(error)) throw error; }
  }
  async function readBase(path) {
    const name = Buffer.from(path).toString('base64url');
    try { return await readFile(join(basesDir, `${name}.bin`)); } catch (error) { if (isMissing(error)) return null; throw error; }
  }
  async function saveBase(path, bytes) {
    if (isSpecial(path)) await atomicWrite(join(basesDir, `${Buffer.from(path).toString('base64url')}.bin`), bytes);
  }
  async function snapshotManifest(entries) {
    return { version: MANIFEST_VERSION, generatedAt: now().toISOString(), files: [...entries.values()].sort((a, b) => a.path.localeCompare(b.path)) };
  }
  async function addConflict({ path, kind, base, local, remote, remoteRev, copyRemote = true }) {
    const record = { id: randomUUID(), path, kind, baseHash: base?.sha256 ?? null, localHash: local ? sha256(local.bytes) : null,
      remoteHash: remote ? sha256(remote.bytes) : null, remoteRev: remoteRev ?? null, host, createdAt: now().toISOString() };
    const rows = await readJson(conflictsPath, []);
    if (!Array.isArray(rows)) throw new SyncTransportError('E_STATE_INVALID');
    rows.push(record);
    await saveJson(conflictsPath, rows);
    if (copyRemote && remote) {
      for (let index = 0; index < 100; index += 1) {
        const copyPath = conflictCopyPath(path, host, now(), index);
        if (isConflictArtifact(copyPath)) {
          try { await safeLocalPath(copyPath); await lstat(resolve(root, copyPath)); continue; }
          catch (error) { if (!isMissing(error)) throw error; }
        }
        await writeLocal(copyPath, remote.bytes);
        record.conflictCopy = copyPath;
        await saveJson(conflictsPath, rows);
        break;
      }
    }
    return record;
  }
  async function activeConflicts() {
    const rows = await readJson(conflictsPath, []);
    if (!Array.isArray(rows)) throw new SyncTransportError('E_STATE_INVALID');
    return rows.filter((row) => !row.resolvedAt);
  }
  async function resolveConflicts(path) {
    const rows = await readJson(conflictsPath, []);
    if (!Array.isArray(rows)) throw new SyncTransportError('E_STATE_INVALID');
    let changed = false;
    for (const row of rows) if (row.path === path && !row.resolvedAt) { row.resolvedAt = now().toISOString(); changed = true; }
    if (changed) await saveJson(conflictsPath, rows);
  }
  async function isPaused() { return (await readJson(settingsPath, {})).paused === true; }

  async function buildManifest() {
    const inventory = await inventoryVault({ vaultPath: root, stateDir, config });
    const rows = await tx.list('');
    const revs = new Map(rows.filter((row) => !row.path.startsWith('.brainatlas-sync/')).map((row) => [row.path, row.rev]));
    const files = [...inventory.files.values()].map((file) => ({ ...entry(file.path, file.bytes, file.mtime, revs.get(file.path)), rev: revs.get(file.path) ?? null }));
    return { version: MANIFEST_VERSION, generatedAt: now().toISOString(), files: files.sort((a, b) => a.path.localeCompare(b.path)), refused: inventory.refused };
  }

  async function checkPeer(peerStateDir) {
    if (typeof peerStateDir !== 'string' || !peerStateDir) throw new SyncTransportError('E_NOT_FOUND');
    const [local, peer] = await Promise.all([readManifest(), readJson(join(peerStateDir, 'sync', 'last-synced-manifest.json'))]);
    if (!validManifest(peer)) return { status: 'DRIFT', differences: [{ path: '', kind: 'manifest-missing' }] };
    const a = new Map(local.files.map((row) => [row.path, row.sha256]));
    const b = new Map(peer.files.map((row) => [row.path, row.sha256]));
    const differences = [];
    for (const path of [...new Set([...a.keys(), ...b.keys()])].sort()) {
      if (!a.has(path)) differences.push({ path, kind: 'missing-local' });
      else if (!b.has(path)) differences.push({ path, kind: 'missing-peer' });
      else if (a.get(path) !== b.get(path)) differences.push({ path, kind: 'modified' });
    }
    return { status: differences.length ? 'DRIFT' : 'PASS', differences };
  }

  async function status() {
    const [manifest, conflicts, pendingDeletes, paused, journal] = await Promise.all([
      readManifest(), readJson(conflictsPath, []), readJson(pendingDeletesPath, []), isPaused(), readJson(journalPath),
    ]);
    if (!Array.isArray(conflicts) || !Array.isArray(pendingDeletes)) throw new SyncTransportError('E_STATE_INVALID');
    const unresolved = conflicts.filter((row) => !row.resolvedAt);
    return { status: paused ? 'PAUSED' : journal?.phase === 'interrupted' ? 'INTERRUPTED' : (pendingDeletes.length || unresolved.length ? 'PENDING' : 'SYNCED'),
      manifestVersion: MANIFEST_VERSION, fileCount: manifest.files.length, conflictCount: unresolved.length, pendingDeleteCount: pendingDeletes.length, paused };
  }

  async function pause() { await ensureState(); await saveJson(settingsPath, { paused: true, updatedAt: now().toISOString() }); return { status: 'PAUSED' }; }
  async function resume() { await ensureState(); await saveJson(settingsPath, { paused: false, updatedAt: now().toISOString() }); return { status: 'RESUMED' }; }

  async function approveDeletes(paths) {
    await ensureState();
    const requested = Array.isArray(paths) ? paths : [paths];
    if (!requested.length || requested.some((path) => typeof path !== 'string' || !path)) throw new SyncTransportError('E_INVALID_PATH');
    const queued = await readJson(pendingDeletesPath, []);
    if (!Array.isArray(queued)) throw new SyncTransportError('E_STATE_INVALID');
    const remaining = [...queued], approved = [];
    const journal = { id: randomUUID(), phase: 'running', startedAt: now().toISOString(), operations: [] };
    await saveJson(journalPath, journal);
    for (const path of requested) {
      safePath(path);
      const index = remaining.findIndex((row) => row.path === path);
      if (index < 0) throw new SyncTransportError('E_NOT_FOUND');
      const record = remaining[index];
      try { await lstat(await safeLocalPath(path)); throw new SyncTransportError('E_CONFLICT'); }
      catch (error) { if (!isMissing(error)) throw error; }
      if (record.rev) {
        const key = tombstonePath(path);
        const object = await tx.get(path);
        const current = await tx.get(key);
        if (!object) {
          let value;
          try { value = current ? JSON.parse(Buffer.from(current.bytes).toString('utf8')) : null; } catch { throw new SyncTransportError('E_STATE_INVALID'); }
          if (value?.version !== 1 || value.path !== path || value.deletedRev !== record.rev) throw new SyncTransportError('E_NOT_FOUND');
        }
        const operation = { path, action: 'approve-delete', desiredHash: null, state: 'running' };
        journal.operations.push(operation); await saveJson(journalPath, journal);
        const tombstone = Buffer.from(`${JSON.stringify({ version: 1, path, deletedRev: record.rev, approvedAt: now().toISOString() })}\n`);
        if (object) {
          await tx.put(key, tombstone, current ? { ifRev: current.rev } : { ifAbsent: true });
          await tx.delete(path, { ifRev: record.rev });
        }
        operation.state = 'done'; await saveJson(journalPath, journal);
      }
      remaining.splice(index, 1); approved.push(path);
      const manifest = await readManifest();
      manifest.files = manifest.files.filter((row) => row.path !== path);
      manifest.generatedAt = now().toISOString();
      await saveJson(manifestPath, manifest);
    }
    await saveJson(pendingDeletesPath, remaining);
    const conflicts = await readJson(conflictsPath, []);
    await saveJson(conflictsPath, conflicts.map((row) => approved.includes(row.path) && row.kind === 'local-delete' && !row.resolvedAt ? { ...row, resolvedAt: now().toISOString() } : row));
    journal.phase = 'complete'; journal.completedAt = now().toISOString(); await saveJson(journalPath, journal);
    return { approved };
  }

  async function run() {
    await ensureState();
    if (await isPaused()) return { status: 'PAUSED', pushed: 0, pulled: 0, merged: 0, pendingDeletes: 0, conflicts: [], refused: [] };
    const previousJournal = await readJson(journalPath);
    const priorRecoverable = previousJournal && previousJournal.phase !== 'complete' ? previousJournal : null;
    const priorOps = new Map((priorRecoverable?.operations ?? []).map((operation) => [operation.path, operation]));
    const journal = { id: randomUUID(), phase: 'planning', startedAt: now().toISOString(), operations: [] };
    await saveJson(journalPath, journal);
    const result = { status: 'SYNCED', pushed: 0, pulled: 0, merged: 0, pendingDeletes: 0, conflicts: [], refused: [] };
    let baseManifest;
    try {
      const inventory = await inventoryVault({ vaultPath: root, stateDir, config });
      const scope = inventory.scope;
      result.refused.push(...inventory.refused.map(({ path, ruleId }) => ({ path, ruleId })));
      const localFiles = inventory.files;
      const remoteRows = await tx.list('');
      const remoteFiles = new Map(), tombstones = new Map(), excluded = new Set(inventory.excluded);
      for (const row of remoteRows) {
        if (row.path.startsWith(TOMBSTONE_PREFIX)) {
          const stored = await tx.get(row.path);
          if (stored) {
            try {
              const value = JSON.parse(Buffer.from(stored.bytes).toString('utf8'));
              if (value?.version === 1 && typeof value.path === 'string' && typeof value.deletedRev === 'string') tombstones.set(value.path, value);
            } catch { throw new SyncTransportError('E_STATE_INVALID'); }
          }
          continue;
        }
        if (row.path.startsWith('.brainatlas-sync/')) continue;
        let path;
        try { path = safePath(row.path); } catch { continue; }
        if (!scope.include.some((glob) => globMatch(glob, path)) || scope.localOnly.some((glob) => globMatch(glob, path))) continue;
        const pathFindings = scanPath(path, { denyGlobs: scope.deny });
        if (pathFindings.length) { result.refused.push({ path, ruleId: pathFindings[0].ruleId }); excluded.add(path); continue; }
        const remote = await tx.get(path);
        if (!remote) continue;
        const findings = scanText(Buffer.from(remote.bytes).toString('utf8'));
        if (findings.length) { result.refused.push({ path, ruleId: findings[0].ruleId }); excluded.add(path); continue; }
        if (isLocalOnlyFrontmatter(Buffer.from(remote.bytes).toString('utf8'))) { excluded.add(path); continue; }
        if (isConflictArtifact(path)) continue;
        remoteFiles.set(path, { bytes: Buffer.from(remote.bytes), rev: remote.rev, hash: sha256(remote.bytes) });
      }
      baseManifest = await readManifest();
      const baseFiles = new Map(baseManifest.files.map((row) => [row.path, row]));
      const nextFiles = new Map(baseFiles);
      for (const path of excluded) nextFiles.delete(path);
      let pendingDeletes = await readJson(pendingDeletesPath, []);
      if (!Array.isArray(pendingDeletes)) throw new SyncTransportError('E_STATE_INVALID');
      const paths = [...new Set([...localFiles.keys(), ...remoteFiles.keys(), ...baseFiles.keys()])].sort();
      journal.phase = 'running';
      await saveJson(journalPath, journal);

      async function recordOperation(path, action, desiredHash = null) {
        const operation = { path, action, desiredHash, state: 'running' };
        journal.operations.push(operation);
        await saveJson(journalPath, journal);
        return operation;
      }
      async function complete(operation) { operation.state = 'done'; await saveJson(journalPath, journal); }
      async function refuse(path, ruleId) {
        if (!result.refused.some((row) => row.path === path && row.ruleId === ruleId)) result.refused.push({ path, ruleId });
      }
      async function acknowledge(path, bytes, rev, localMtime) {
        const saved = entry(path, bytes, localMtime ?? now().getTime(), rev);
        nextFiles.set(path, saved);
        await saveBase(path, bytes);
        await resolveConflicts(path);
        return saved;
      }
      async function conflict(path, kind, local, remote, base, rev, copy = true) {
        let safeRemote = remote;
        if (remote) {
          const pathFindings = scanPath(path, { denyGlobs: scope.deny });
          const contentFindings = scanText(remote.bytes.toString('utf8'));
          if (pathFindings.length || contentFindings.length) {
            await refuse(path, (pathFindings[0] ?? contentFindings[0]).ruleId);
            safeRemote = null;
            copy = false;
          }
        }
        const operation = await recordOperation(path, `conflict-${kind}`, remote ? sha256(remote.bytes) : null);
        const record = await addConflict({ path, kind, local, remote: safeRemote, base, remoteRev: rev, copyRemote: copy });
        operation.state = 'conflict'; await saveJson(journalPath, journal);
        result.conflicts.push({ path, kind, ...(record.conflictCopy ? { conflictCopy: record.conflictCopy } : {}) });
        result.status = 'CONFLICT';
      }
      async function pull(path, remote, local, base) {
        const operation = await recordOperation(path, 'pull', remote.hash);
        const pathFindings = scanPath(path, { denyGlobs: scope.deny });
        const contentFindings = scanText(remote.bytes.toString('utf8'));
        if (pathFindings.length || contentFindings.length) {
          await refuse(path, (pathFindings[0] ?? contentFindings[0]).ruleId);
          operation.state = 'refused'; await saveJson(journalPath, journal); return;
        }
        const written = await writeLocal(path, remote.bytes);
        await acknowledge(path, remote.bytes, remote.rev, written.mtimeMs);
        await complete(operation);
        result.pulled += 1;
      }
      async function push(path, local, remote, base, bytes = local.bytes, merged = false) {
        const payload = Buffer.from(bytes), hash = sha256(payload);
        const pathFindings = scanPath(path, { denyGlobs: scope.deny });
        const contentFindings = scanText(payload.toString('utf8'));
        if (pathFindings.length || contentFindings.length) { await refuse(path, (pathFindings[0] ?? contentFindings[0]).ruleId); return false; }
        const operation = await recordOperation(path, merged ? 'merge-put' : 'put', hash);
        try {
          const options = remote ? { ifRev: remote.rev } : { ifAbsent: true };
          const stored = await tx.put(path, payload, options);
          if (merged) {
            const saved = await writeLocal(path, payload);
            await acknowledge(path, payload, stored.rev, saved.mtimeMs);
            result.merged += 1;
          } else if (local) await acknowledge(path, payload, stored.rev, local.mtime);
          await complete(operation);
          result.pushed += merged ? 0 : 1;
          return true;
        } catch (error) {
          if (error?.code !== 'E_CONFLICT') throw error;
          const latest = await tx.get(path);
          if (latest && sha256(latest.bytes) === hash) {
            if (merged) {
              const saved = await writeLocal(path, payload);
              await acknowledge(path, payload, latest.rev, saved.mtimeMs);
              result.merged += 1;
            } else await acknowledge(path, payload, latest.rev, local?.mtime);
            await complete(operation);
            return true;
          }
          const latestRemote = latest ? { bytes: Buffer.from(latest.bytes), rev: latest.rev, hash: sha256(latest.bytes) } : null;
          await conflict(path, 'cas-conflict', local, latestRemote, base, latest?.rev ?? null);
          operation.state = 'conflict'; await saveJson(journalPath, journal);
          return false;
        }
      }

      for (const path of paths) {
        if (excluded.has(path)) continue;
        const local = localFiles.get(path) ?? null;
        const remote = remoteFiles.get(path) ?? null;
        const base = baseFiles.get(path) ?? null;
        const pendingIndex = pendingDeletes.findIndex((row) => row.path === path);
        if (local && pendingIndex >= 0) { pendingDeletes.splice(pendingIndex, 1); await saveJson(pendingDeletesPath, pendingDeletes); }

        const recovery = priorOps.get(path);
        if (recovery && recovery.state !== 'refused' && recovery.desiredHash && local && remote
            && sha256(local.bytes) === recovery.desiredHash && remote.hash === recovery.desiredHash) {
          const op = await recordOperation(path, 'recover-ack', recovery.desiredHash);
          await acknowledge(path, local.bytes, remote.rev, local.mtime);
          await complete(op);
          continue;
        }

        if (!base) {
          if (!local && !remote) continue;
          if (!local && remote) { await pull(path, remote, null, null); continue; }
          if (local && !remote) { await push(path, local, null, null); continue; }
          if (sha256(local.bytes) === remote.hash) {
            const op = await recordOperation(path, 'ack-identical', remote.hash);
            await acknowledge(path, local.bytes, remote.rev, local.mtime); await complete(op); continue;
          }
          if (isSpecial(path)) {
            const merged = mergeCanonicalPath(path, null, local.bytes.toString('utf8'), remote.bytes.toString('utf8'));
            if (!merged.conflicts.length && merged.content !== null) {
              const bytes = Buffer.from(merged.content);
              if (bytes.equals(remote.bytes)) { const saved = await writeLocal(path, bytes); await acknowledge(path, bytes, remote.rev, saved.mtimeMs); result.merged += 1; continue; }
              await push(path, local, remote, null, bytes, true); continue;
            }
          }
          await conflict(path, 'unbased-divergence', local, remote, null, remote.rev); continue;
        }

        if (!local && !remote) {
          nextFiles.delete(path);
          const op = await recordOperation(path, 'ack-delete', null); await complete(op); continue;
        }
        if (!local && remote) {
          const record = { path, rev: remote.rev, hash: remote.hash, requestedAt: now().toISOString() };
          if (!pendingDeletes.some((row) => row.path === path)) pendingDeletes.push(record);
          await saveJson(pendingDeletesPath, pendingDeletes);
          result.pendingDeletes += 1; result.status = result.status === 'CONFLICT' ? result.status : 'PENDING';
          const op = await recordOperation(path, 'queue-delete', null); await complete(op); continue;
        }
        if (local && !remote) {
          const tombstone = tombstones.get(path);
          if (tombstone?.deletedRev === base.rev && local.bytes && sha256(local.bytes) === base.sha256) {
            const op = await recordOperation(path, 'approved-remote-delete', null);
            await deleteLocal(path);
            nextFiles.delete(path);
            await complete(op);
            continue;
          }
          await conflict(path, tombstone ? 'approved-delete-local-changed' : 'remote-delete', local, null, base, null, false); continue;
        }

        const localHash = sha256(local.bytes);
        const localChanged = localHash !== base.sha256;
        const remoteChanged = remote.hash !== base.sha256;
        if (!localChanged && !remoteChanged) {
          await acknowledge(path, local.bytes, remote.rev, local.mtime); continue;
        }
        if (!localChanged && remoteChanged) { await pull(path, remote, local, base); continue; }
        if (localChanged && !remoteChanged) { await push(path, local, remote, base); continue; }
        if (localHash === remote.hash) {
          const op = await recordOperation(path, 'ack-identical', localHash);
          await acknowledge(path, local.bytes, remote.rev, local.mtime); await complete(op); continue;
        }
        if (isSpecial(path)) {
          const original = await readBase(path);
          if (original) {
            const merged = mergeCanonicalPath(path, original.toString('utf8'), local.bytes.toString('utf8'), remote.bytes.toString('utf8'));
            if (!merged.conflicts.length && merged.content !== null) {
              await push(path, local, remote, base, Buffer.from(merged.content), true); continue;
            }
          }
          await conflict(path, 'merge-conflict', local, remote, base, remote.rev); continue;
        }
        await conflict(path, 'edit-conflict', local, remote, base, remote.rev);
      }

      await saveJson(pendingDeletesPath, pendingDeletes);
      const manifest = await snapshotManifest(nextFiles);
      await saveJson(manifestPath, manifest);
      journal.phase = 'complete'; journal.completedAt = now().toISOString();
      await saveJson(journalPath, journal);
      const conflictRows = await activeConflicts();
      result.conflicts = conflictRows.map(({ path, kind, conflictCopy }) => ({ path, kind, ...(conflictCopy ? { conflictCopy } : {}) }));
      result.pendingDeletes = pendingDeletes.length;
      if (result.conflicts.length) result.status = 'CONFLICT';
      else if (pendingDeletes.length || result.refused.length) result.status = 'PENDING';
      logger.info?.('sync run completed', { status: result.status, pushed: result.pushed, pulled: result.pulled, merged: result.merged, pendingDeletes: result.pendingDeletes, conflicts: result.conflicts.length, refused: result.refused.length });
      return result;
    } catch (error) {
      journal.phase = error?.code === 'E_INTERRUPTED' ? 'interrupted' : 'failed';
      journal.errorCode = classifySyncError(error) ?? 'E_DEGRADED';
      await saveJson(journalPath, journal).catch(() => {});
      if (error instanceof BrainAtlasError || error instanceof SyncTransportError) throw error;
      throw new SyncTransportError(classifySyncError(error) ?? 'E_DEGRADED');
    }
  }

  return Object.freeze({ buildManifest, checkPeer, status, run, approveDeletes, pause, resume, transport: tx,
    stateDir, vaultPath: root, manifestPath, journalPath });
}

export const createEngine = createSyncEngine;
