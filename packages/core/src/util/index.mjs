// SPDX-License-Identifier: MIT
import { NotImplementedError, BrainAtlasError } from './errors.mjs';
import { lstat, mkdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
export { NotImplementedError, BrainAtlasError };
/** @param {string} file @param {string|Uint8Array} data @param {{mode?:number}} options */
export async function atomicWriteFile(file, data, options = {}) {
  if (typeof file !== 'string' || data === undefined) throw new NotImplementedError('util.atomicWriteFile');
  const target = resolve(file);
  const temp = join(dirname(target), `.${target.split(sep).at(-1)}.${randomUUID()}.tmp`);
  await mkdir(dirname(target), { recursive: true });
  try {
    await writeFile(temp, data, { mode: options.mode });
    await rename(temp, target);
  } catch (error) {
    try { await unlink(temp); } catch {}
    throw error;
  }
}
/** @param {string} root @param {string} rel */
export function safeJoin(root, rel) {
  if (typeof root !== 'string' || typeof rel !== 'string') throw new NotImplementedError('util.safeJoin');
  const clean = rel.replace(/\/+$/, '');
  if (!clean || isAbsolute(clean) || clean.includes('\\') || clean.includes('\0') || clean.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new BrainAtlasError('E_PATH_ESCAPE', 'Path is invalid.');
  }
  const base = resolve(root);
  const target = resolve(base, clean);
  const from = relative(base, target);
  if (!from || from === '..' || from.startsWith(`..${sep}`) || isAbsolute(from)) throw new BrainAtlasError('E_PATH_ESCAPE', 'Path is invalid.');
  return target;
}

/** Return a vault-relative path after checking every existing component's real path. */
export async function resolveSafePath(root, rel) {
  const base = resolve(root);
  const target = safeJoin(base, rel);
  const parts = relative(base, target).split(sep);
  let current = base;
  for (let i = 0; i < parts.length; i++) {
    const candidate = join(current, parts[i]);
    try {
      await lstat(candidate);
      let actual;
      try { actual = await realpath(candidate); }
      catch { throw new BrainAtlasError('E_PATH_ESCAPE', 'Path resolves outside the vault.'); }
      const from = relative(base, actual);
      if (actual !== base && (from === '..' || from.startsWith(`..${sep}`) || isAbsolute(from))) throw new BrainAtlasError('E_PATH_ESCAPE', 'Path resolves outside the vault.');
      current = actual;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      current = candidate;
      for (const rest of parts.slice(i + 1)) current = join(current, rest);
      return current;
    }
  }
  return current;
}
/** @param {string} cmd @param {string[]} args @param {{cwd:string,env?:object,timeoutMs?:number}} options */
export async function runCommand(cmd, args, options) { throw new NotImplementedError('util.runCommand'); }

