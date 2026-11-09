// SPDX-License-Identifier: MIT
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, lstat, readFile, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PREPROCESS_VERSION } from './provider.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

async function markdownFiles(root, dir = root, files = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) await markdownFiles(root, fullPath, files);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      files.push({ fullPath, relativePath: path.relative(root, fullPath).split(path.sep).join('/') });
    }
  }
  return files;
}

async function rejectSymlink(target) {
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink()) throw Object.assign(new Error('Semantic state path must not be a symlink.'), { code: 'E_SEMANTIC_STATE' });
    return info;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

const updates = new Map();
function checkAbort(signal) {
  if (signal?.aborted) throw Object.assign(new Error('Semantic indexing aborted.'), { code: 'E_SEMANTIC_ABORTED' });
}
/** Update once per state directory; concurrent callers share the same work. */
export function updateSemanticIndex(options) {
  if (options.signal?.aborted) return Promise.reject(Object.assign(new Error('Semantic indexing aborted.'), { code: 'E_SEMANTIC_ABORTED' }));
  const key = path.resolve(options.stateDir);
  if (updates.has(key)) return updates.get(key);
  const work = updateIndex(options).finally(() => updates.delete(key));
  updates.set(key, work);
  return work;
}
export async function buildSemanticIndex(options) { return updateIndex({ ...options, force: true }); }

export const SLOW_BATCH_MS = 20000;
export const FAST_BATCH_MS = 5000;
export const CHECKPOINT_INTERVAL_MS = 30000;
const LOCK_MAX_AGE_MS = 6 * 60 * 60 * 1000;

async function stateDirectory(stateDir) {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const dir = path.join(stateDir, 'semantic');
  const info = await rejectSymlink(dir);
  if (info && !info.isDirectory()) throw Object.assign(new Error('Semantic state path is invalid.'), { code: 'E_SEMANTIC_STATE' });
  if (!info) await mkdir(dir, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  if (!(await rejectSymlink(dir))?.isDirectory()) throw Object.assign(new Error('Semantic state path is invalid.'), { code: 'E_SEMANTIC_STATE' });
  return dir;
}
async function atomicWrite(destination, value) {
  const info = await rejectSymlink(destination);
  if (info && !info.isFile()) throw Object.assign(new Error('Semantic state path is invalid.'), { code: 'E_SEMANTIC_STATE' });
  const temporary = `${destination}.tmp-${process.pid}-${randomUUID()}`;
  try { await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' }); await rename(temporary, destination); }
  finally { await unlink(temporary).catch(() => {}); }
}
export async function readPartialIndex(stateDir, provider) {
  try {
    const dir = path.join(stateDir, 'semantic');
    if (!(await rejectSymlink(dir))?.isDirectory()) return null;
    const file = path.join(dir, 'index.partial.json');
    if (!(await rejectSymlink(file))?.isFile()) return null;
    const data = JSON.parse(await readFile(file, 'utf8'));
    if (data.version !== 1 || data.providerFingerprint !== (provider.fingerprint ?? null) || data.dims !== provider.dims || data.preprocessVersion !== (provider.preprocessVersion ?? PREPROCESS_VERSION) || !data.vectors || typeof data.vectors !== 'object' || Array.isArray(data.vectors)) return null;
    if (Object.entries(data.vectors).some(([key, vector]) => !/^[a-f0-9]{64}$/u.test(key) || !Array.isArray(vector) || vector.length !== provider.dims || !vector.every(Number.isFinite))) return null;
    return data;
  } catch { return null; }
}
async function acquireLock(dir, now) {
  const lock = path.join(dir, 'index.lock');
  for (let attempt = 0; attempt < 3; attempt++) {
    await rejectSymlink(lock);
    try { await writeFile(lock, JSON.stringify({ pid: process.pid, startedAt: now() }), { flag: 'wx', mode: 0o600 }); return lock; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let existing;
      try { existing = JSON.parse(await readFile(lock, 'utf8')); } catch { existing = null; }
      let alive = false;
      if (Number.isInteger(existing?.pid) && existing.pid > 0) { try { process.kill(existing.pid, 0); alive = true; } catch (e) { alive = e.code === 'EPERM'; } }
      if (alive && Number.isFinite(existing.startedAt) && now() - existing.startedAt < LOCK_MAX_AGE_MS) throw Object.assign(new Error('Another indexing operation is running.'), { code: 'E_SEMANTIC_BUSY' });
      await rejectSymlink(lock);
      await unlink(lock).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }
  throw Object.assign(new Error('Another indexing operation is running.'), { code: 'E_SEMANTIC_BUSY' });
}

async function scan({ corpusDir, stateDir, provider, chunkMarkdown, force = false, onProgress, now = Date.now }) {
  const start = now();
  const root = await realpath(corpusDir);
  const files = (await markdownFiles(root)).sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  const previous = force ? null : await readSemanticIndex(stateDir);
  const reusable = previous && previous.providerFingerprint === provider.fingerprint && previous.dims === provider.dims ? previous : null;
  const chunks = [], retained = [], hashes = {};
  await onProgress?.({ phase: 'scan', done: 0, total: files.length, elapsedMs: 0, etaMs: null, batchSize: 0 });
  for (const [i, file] of files.entries()) {
    const source = await readFile(file.fullPath, 'utf8');
    hashes[file.relativePath] = sha256(source);
    if (reusable && reusable.fileHashes[file.relativePath] === hashes[file.relativePath]) retained.push(...reusable.entries.filter(entry => entry.path === file.relativePath));
    else chunks.push(...chunkMarkdown(source, file.relativePath));
    await onProgress?.({ phase: 'scan', done: i + 1, total: files.length, elapsedMs: now() - start, etaMs: null, batchSize: 0 });
  }
  return { chunks, retained, hashes, reusable, start };
}
export async function countPendingChunks(options) {
  const { chunks } = await scan(options);
  const partial = await readPartialIndex(options.stateDir, options.provider);
  return chunks.filter(chunk => !Object.hasOwn(partial?.vectors ?? {}, sha256(chunk.text))).length;
}
async function updateIndex({ corpusDir, stateDir, provider, chunkMarkdown, force = false, skipUnchangedWrite = false, onProgress, indexBatchSize = 32, now = Date.now, signal }) {
  checkAbort(signal);
  if (!provider || (typeof provider.embed !== 'function' && typeof provider.embedDocuments !== 'function') || !Number.isInteger(provider.dims)) throw new TypeError('Invalid embedding provider.');
  if (!Number.isInteger(indexBatchSize) || indexBatchSize < 1 || indexBatchSize > 64) throw new TypeError('Invalid index batch size.');
  const dir = await stateDirectory(stateDir);
  checkAbort(signal);
  const lock = await acquireLock(dir, now);
  const partialPath = path.join(dir, 'index.partial.json');
  try {
    checkAbort(signal);
    if (force) { await rejectSymlink(partialPath); await unlink(partialPath).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    const { chunks, retained, hashes, reusable, start } = await scan({ corpusDir, stateDir, provider, chunkMarkdown, force, onProgress, now });
    checkAbort(signal);
    if (skipUnchangedWrite && reusable && Object.keys(hashes).length === Object.keys(reusable.fileHashes).length && Object.entries(hashes).every(([key, hash]) => reusable.fileHashes[key] === hash)) return reusable;
    const partial = (!force && await readPartialIndex(stateDir, provider)) || { version: 1, providerFingerprint: provider.fingerprint ?? null, dims: provider.dims, preprocessVersion: provider.preprocessVersion ?? PREPROCESS_VERSION, vectors: {} };
    const vectors = new Array(chunks.length);
    const pending = [];
    for (const [i, chunk] of chunks.entries()) { const hash = sha256(chunk.text); if (Object.hasOwn(partial.vectors, hash)) vectors[i] = partial.vectors[hash]; else pending.push({ i, hash, text: chunk.text }); }
    let done = chunks.length - pending.length, batchSize = Math.min(indexBatchSize, 32), completed = 0, elapsedEmbed = 0, lastWrite = now(), dirty = false;
    const report = async etaMs => onProgress?.({ phase: 'embed', done, total: chunks.length, elapsedMs: now() - start, etaMs, batchSize });
    try {
      await report(null);
      for (let offset = 0; offset < pending.length;) {
        checkAbort(signal);
        const batch = pending.slice(offset, offset + batchSize); const before = now();
        let result;
        try { result = await (provider.embedDocuments ?? provider.embed).call(provider, batch.map(item => item.text)); }
        catch (error) { checkAbort(signal); throw error; }
        checkAbort(signal);
        if (!Array.isArray(result) || result.length !== batch.length || result.some(vector => !vector || vector.length !== provider.dims || !Array.from(vector).every(Number.isFinite))) throw new Error('Embedding provider returned invalid vectors.');
        for (const [i, item] of batch.entries()) { vectors[item.i] = Array.from(result[i]); partial.vectors[item.hash] = vectors[item.i]; }
        dirty = true; offset += batch.length; done += batch.length; completed += batch.length;
        const duration = Math.max(0, now() - before); elapsedEmbed += duration;
        if (duration > SLOW_BATCH_MS) batchSize = Math.max(1, Math.floor(batchSize / 2));
        else if (duration < FAST_BATCH_MS) batchSize = Math.min(indexBatchSize, batchSize * 2);
        if (now() - lastWrite >= CHECKPOINT_INTERVAL_MS) { await atomicWrite(partialPath, partial); dirty = false; lastWrite = now(); }
        await report(elapsedEmbed / completed * (chunks.length - done));
      }
      checkAbort(signal);
      const index = { version: 1, providerId: provider.id, providerFingerprint: provider.fingerprint ?? null, preprocessVersion: provider.preprocessVersion ?? PREPROCESS_VERSION, dims: provider.dims, createdAt: new Date().toISOString(), fileHashes: hashes, entries: [...retained, ...chunks.map((chunk, i) => ({ ...chunk, vector: vectors[i] }))] };
      await atomicWrite(path.join(dir, 'index.json'), index);
      await rejectSymlink(partialPath); await unlink(partialPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
      dirty = false;
      return index;
    } finally { if (dirty && !signal?.aborted) await atomicWrite(partialPath, partial); }
  } finally { await unlink(lock).catch(() => {}); }
}

/** Read a stored index without exposing file contents in errors. */
export async function readSemanticIndex(stateDir) {
  try {
    const semanticDir = path.join(stateDir, 'semantic');
    const semanticInfo = await rejectSymlink(semanticDir);
    if (semanticInfo && !semanticInfo.isDirectory()) return null;
    const indexPath = path.join(semanticDir, 'index.json');
    const indexInfo = await rejectSymlink(indexPath);
    if (indexInfo && !indexInfo.isFile()) return null;
    const parsed = JSON.parse(await readFile(indexPath, 'utf8'));
    if (parsed?.version !== 1 || !Number.isInteger(parsed.dims) || parsed.dims < 1 || !Array.isArray(parsed.entries) || !parsed.fileHashes || typeof parsed.fileHashes !== 'object' || Array.isArray(parsed.fileHashes) || parsed.entries.some(e => !e || typeof e.path !== 'string' || typeof e.text !== 'string' || !Array.isArray(e.vector) || e.vector.length !== parsed.dims || !e.vector.every(Number.isFinite))) return null;
    return parsed;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    if (error?.code === 'E_SEMANTIC_STATE') return null;
    return null;
  }
}

/** Report indexed, stale and missing source counts and index age in seconds. */
export async function measureIndexFreshness({ corpusDir, index, now = new Date() }) {
  const root = await realpath(corpusDir);
  const files = await markdownFiles(root);
  const current = new Map();
  for (const file of files) current.set(file.relativePath, sha256(await readFile(file.fullPath)));
  const stored = index?.fileHashes ?? {};
  let stale = 0;
  for (const [file, hash] of Object.entries(stored)) if (current.has(file) && current.get(file) !== hash) stale++;
  let missing = 0;
  for (const file of current.keys()) if (!Object.hasOwn(stored, file)) missing++;
  const indexed = Object.keys(stored).length;
  const created = Date.parse(index?.createdAt ?? '');
  return { indexed, stale, missing, ageSeconds: Number.isFinite(created) ? Math.max(0, (now.getTime() - created) / 1000) : null };
}

