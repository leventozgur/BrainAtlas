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

/** Build and atomically persist a local embedding index and source hash manifest. */
export async function buildSemanticIndex({ corpusDir, stateDir, provider, chunkMarkdown }) {
  if (!provider || (typeof provider.embed !== 'function' && typeof provider.embedDocuments !== 'function') || !Number.isInteger(provider.dims)) throw new TypeError('Invalid embedding provider.');
  const root = await realpath(corpusDir);
  const files = (await markdownFiles(root)).sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  const chunks = [];
  const hashes = {};
  for (const file of files) {
    const source = await readFile(file.fullPath, 'utf8');
    hashes[file.relativePath] = sha256(source);
    chunks.push(...chunkMarkdown(source, file.relativePath));
  }
  const vectors = chunks.length ? await (provider.embedDocuments ?? provider.embed).call(provider, chunks.map((chunk) => chunk.text)) : [];
  if (vectors.length !== chunks.length || vectors.some((vector) => vector.length !== provider.dims)) {
    throw new Error('Embedding provider returned invalid vectors.');
  }
  const createdAt = new Date().toISOString();
  const index = { version: 1, providerId: provider.id, providerFingerprint: provider.fingerprint ?? null, preprocessVersion: provider.preprocessVersion ?? PREPROCESS_VERSION, dims: provider.dims, createdAt, fileHashes: hashes,
    entries: chunks.map((chunk, i) => ({ ...chunk, vector: Array.from(vectors[i]) })) };
  // stateDir itself may be a user-directed symlink; descendants are owned paths.
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const semanticDir = path.join(stateDir, 'semantic');
  const semanticInfo = await rejectSymlink(semanticDir);
  if (semanticInfo && !semanticInfo.isDirectory()) throw Object.assign(new Error('Semantic state path is invalid.'), { code: 'E_SEMANTIC_STATE' });
  if (!semanticInfo) await mkdir(semanticDir, { mode: 0o700 });
  const destination = path.join(semanticDir, 'index.json');
  const destinationInfo = await rejectSymlink(destination);
  if (destinationInfo && !destinationInfo.isFile()) throw Object.assign(new Error('Semantic index path is invalid.'), { code: 'E_SEMANTIC_STATE' });
  const temporary = `${destination}.tmp-${process.pid}-${randomUUID()}`;
  await rejectSymlink(temporary);
  await writeFile(temporary, `${JSON.stringify(index)}\n`, { mode: 0o600, flag: 'wx' });
  try { await rename(temporary, destination); }
  catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  return index;
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
    if (parsed?.version !== 1 || !Array.isArray(parsed.entries) || !parsed.fileHashes || typeof parsed.fileHashes !== 'object') return null;
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

