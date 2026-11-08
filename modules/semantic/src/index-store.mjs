// SPDX-License-Identifier: MIT
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

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

/** Build and atomically persist a local embedding index and source hash manifest. */
export async function buildSemanticIndex({ corpusDir, stateDir, provider, chunkMarkdown }) {
  if (!provider || typeof provider.embed !== 'function' || !Number.isInteger(provider.dims)) throw new TypeError('Invalid embedding provider.');
  const root = await realpath(corpusDir);
  const files = (await markdownFiles(root)).sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  const chunks = [];
  const hashes = {};
  for (const file of files) {
    const source = await readFile(file.fullPath, 'utf8');
    hashes[file.relativePath] = sha256(source);
    chunks.push(...chunkMarkdown(source, file.relativePath));
  }
  const vectors = chunks.length ? await provider.embed(chunks.map((chunk) => chunk.text)) : [];
  if (vectors.length !== chunks.length || vectors.some((vector) => vector.length !== provider.dims)) {
    throw new Error('Embedding provider returned invalid vectors.');
  }
  const createdAt = new Date().toISOString();
  const index = { version: 1, providerId: provider.id, dims: provider.dims, createdAt, fileHashes: hashes,
    entries: chunks.map((chunk, i) => ({ ...chunk, vector: Array.from(vectors[i]) })) };
  const semanticDir = path.join(stateDir, 'semantic');
  await mkdir(semanticDir, { recursive: true, mode: 0o700 });
  const destination = path.join(semanticDir, 'index.json');
  const temporary = `${destination}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(index)}\n`, { mode: 0o600 });
  await rename(temporary, destination);
  return index;
}

/** Read a stored index without exposing file contents in errors. */
export async function readSemanticIndex(stateDir) {
  try {
    const parsed = JSON.parse(await readFile(path.join(stateDir, 'semantic', 'index.json'), 'utf8'));
    if (parsed?.version !== 1 || !Array.isArray(parsed.entries) || !parsed.fileHashes) throw new Error();
    return parsed;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw Object.assign(new Error('Semantic index is unreadable.'), { code: 'E_SEMANTIC_INDEX' });
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

