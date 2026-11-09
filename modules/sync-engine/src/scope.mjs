// SPDX-License-Identifier: MIT
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { scanPath, scanText, isSafetyFindingAllowed } from '../../../packages/core/src/safety/index.mjs';
import { SyncTransportError } from './transport.mjs';

const DEFAULT_INCLUDE = Object.freeze(['**/*.md']);
const normalize = (path) => path.replace(/\\/g, '/').replace(/^\.\//, '');
const conflictArtifact = (path) => /\.conflict-[a-z0-9_-]+-\d{8}T\d{6}Z(?:-\d+)?\.md$/i.test(path);
const cachePath = (path) => {
  const parts = normalize(path).split('/');
  return parts.includes('.brainatlas-state') || parts.includes('semantic') || parts.at(-1) === 'retrieval-index.json';
};

function segmentMatch(pattern, value) {
  let p = 0, v = 0, star = -1, retry = 0;
  while (v < value.length) {
    if (p < pattern.length && (pattern[p] === '?' || pattern[p].toLowerCase() === value[v].toLowerCase())) { p += 1; v += 1; }
    else if (pattern[p] === '*') { star = p++; retry = v; }
    else if (star >= 0) { p = star + 1; v = ++retry; }
    else return false;
  }
  while (pattern[p] === '*') p += 1;
  return p === pattern.length;
}

export function globMatch(glob, path) {
  const patterns = normalize(glob).split('/').filter(Boolean);
  const parts = normalize(path).split('/').filter(Boolean);
  const memo = new Map();
  function match(pi, si) {
    const key = `${pi}:${si}`;
    if (memo.has(key)) return memo.get(key);
    let result;
    if (pi === patterns.length) result = si === parts.length;
    else if (patterns[pi] === '**') result = match(pi + 1, si) || (si < parts.length && match(pi, si + 1));
    else result = si < parts.length && segmentMatch(patterns[pi], parts[si]) && match(pi + 1, si + 1);
    memo.set(key, result);
    return result;
  }
  return match(0, 0);
}

export function resolveSyncScope(config = {}) {
  const options = config?.sync?.options ?? config?.sync ?? {};
  const include = options.include ?? DEFAULT_INCLUDE;
  const localOnly = options.localOnly ?? options['local-only'] ?? [];
  const deny = options.deny ?? [];
  for (const rows of [include, localOnly, deny]) {
    if (!Array.isArray(rows) || rows.some((pattern) => typeof pattern !== 'string' || !pattern || pattern.startsWith('/') || pattern.includes('\\') || pattern.split('/').includes('..'))) {
      throw new SyncTransportError('E_STATE_INVALID');
    }
  }
  return { include: [...include], localOnly: [...localOnly], deny: [...deny] };
}

export function isLocalOnlyFrontmatter(text) {
  const source = text.replace(/^\uFEFF/, '');
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
  return Boolean(match && /^\s*sync\s*:\s*local\s*(?:#.*)?$/im.test(match[1]));
}

function safeRelative(path) {
  return typeof path === 'string' && path.length > 0 && !path.startsWith('/') && !path.includes('\\') && !path.includes('\0')
    && path.split('/').every((part) => part && part !== '.' && part !== '..');
}

async function walk(root, ignoredDir, output, allowedPaths, excluded, current = root) {
  let entries;
  try { entries = await readdir(current, { withFileTypes: true }); }
  catch (error) { if (error?.code === 'ENOENT') return; throw error; }
  for (const entry of entries) {
    const absolute = join(current, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      const rel = normalize(relative(root, absolute));
      if (ignoredDir && (rel === ignoredDir || rel.startsWith(`${ignoredDir}/`))) continue;
      if (scanPath(`${rel}/sentinel.md`).length && !allowedPaths.some((path) => path.startsWith(`${rel}/`))) continue;
      await walk(root, ignoredDir, output, allowedPaths, excluded, absolute);
    } else if (entry.isFile()) {
      const path = normalize(relative(root, absolute));
      if (!safeRelative(path)) continue;
      if (cachePath(path)) { excluded.add(path); continue; }
      if (!conflictArtifact(path)) output.push({ path, absolute });
    }
  }
}

/** Collect scoped files and secret refusals without returning or persisting matching values. */
export async function inventoryVault({ vaultPath, stateDir, config = {} }) {
  const scope = resolveSyncScope(config);
  const rootInfo = await lstat(vaultPath).catch(() => null);
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) throw new SyncTransportError('E_NOT_FOUND');
  let ignoredDir = null;
  if (stateDir) {
    const relativeState = normalize(relative(vaultPath, stateDir));
    if (relativeState && !relativeState.startsWith('../') && relativeState !== '..') ignoredDir = relativeState;
  }
  const candidates = [];
  const excluded = new Set();
  const allowed = Array.isArray(config?.safety?.allow) ? config.safety.allow : [];
  const allowedPaths = allowed.map((entry) => entry?.path).filter((path) => typeof path === 'string');
  await walk(vaultPath, ignoredDir, candidates, allowedPaths, excluded);
  const included = new Map();
  const refused = [];
  const seen = new Map();
  const extraDenyGlobs = Array.isArray(config?.safety?.extraDenyGlobs) ? config.safety.extraDenyGlobs : [];
  for (const { path, absolute } of candidates.sort((a, b) => a.path.localeCompare(b.path))) {
    const denied = scanPath(path, { denyGlobs: scope.deny, extraDenyGlobs })
      .filter((finding) => !isSafetyFindingAllowed(path, '', finding, allowed));
    if (denied.length) {
      for (const finding of denied) refused.push({ path, ruleId: finding.ruleId });
      excluded.add(path);
      continue;
    }
    if (!scope.include.some((glob) => globMatch(glob, path)) || scope.localOnly.some((glob) => globMatch(glob, path))) { excluded.add(path); continue; }
    let bytes;
    try { bytes = await readFile(absolute); } catch (error) { if (error?.code === 'ENOENT') continue; throw error; }
    if (isLocalOnlyFrontmatter(bytes.toString('utf8'))) { excluded.add(path); continue; }
    const text = bytes.toString('utf8');
    const findings = scanText(text).filter((finding) => !isSafetyFindingAllowed(path, text, finding, allowed));
    if (findings.length) {
      refused.push({ path, ruleId: findings[0].ruleId });
      excluded.add(path);
      continue;
    }
    const collisionGroup = seen.get(path.toLowerCase()) ?? [];
    if (collisionGroup.length) {
      collisionGroup.push(path);
      seen.set(path.toLowerCase(), collisionGroup);
      for (const collided of collisionGroup) {
        included.delete(collided); excluded.add(collided);
        if (!refused.some((row) => row.path === collided && row.ruleId === 'case-collision')) refused.push({ path: collided, ruleId: 'case-collision' });
      }
      continue;
    }
    seen.set(path.toLowerCase(), [path]);
    const stat = await lstat(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) continue;
    included.set(path, { path, bytes, size: bytes.byteLength, mtime: stat.mtimeMs });
  }
  return { scope, files: included, refused, excluded };
}

export { DEFAULT_INCLUDE };
