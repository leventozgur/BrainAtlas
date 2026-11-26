// SPDX-License-Identifier: MIT
import { accessSync, constants, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

/** @typedef {string | {path: string, label: string}} DetectPath */

/** @param {string} path @param {'dir' | 'file'} kind */
function isKind(path, kind) {
  try {
    const stat = statSync(path);
    return kind === 'dir' ? stat.isDirectory() : stat.isFile();
  } catch {
    return false;
  }
}

/** @param {string} path */
function isExecutable(path) {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {unknown} entry @param {string} home @returns {{path: string, label: string} | null}
 */
function resolveEntry(entry, home) {
  if (typeof entry === 'string') {
    if (!entry || isAbsolute(entry)) return null;
    return { path: join(home, entry), label: `~/${entry}` };
  }
  const item = /** @type {any} */ (entry);
  if (item && typeof item.path === 'string' && isAbsolute(item.path) && typeof item.label === 'string' && item.label)
    return { path: item.path, label: item.label };
  return null;
}

/**
 * @param {{env?: Record<string, any> | null, dirs?: DetectPath[], files?: DetectPath[], commands?: string[], globs?: {dir: string, prefix: string}[]}} options
 * @returns {{detected: boolean, evidence: string[]}}
 */
export function detectEvidence({ env, dirs = [], files = [], commands = [], globs = [] } = {}) {
  /** @type {string[]} */
  const evidence = [];
  try {
    const home = env?.HOME;
    if (typeof home !== 'string' || !home || !isAbsolute(home)) return { detected: false, evidence: [] };
    /** @param {string} label */
    const add = (label) => {
      if (!evidence.includes(label)) evidence.push(label);
    };
    for (const [list, kind] of /** @type {const} */ ([
      [dirs, 'dir'],
      [files, 'file'],
    ]))
      for (const entry of list ?? []) {
        const resolved = resolveEntry(entry, home);
        if (resolved && isKind(resolved.path, kind)) add(resolved.label);
      }
    for (const glob of globs ?? []) {
      if (!glob || typeof glob.dir !== 'string' || typeof glob.prefix !== 'string' || isAbsolute(glob.dir)) continue;
      try {
        if (readdirSync(join(home, glob.dir)).some((name) => name.startsWith(glob.prefix)))
          add(`~/${glob.dir}/${glob.prefix}*`);
        // eslint-disable-next-line no-empty
      } catch {}
    }
    const entries = typeof env?.PATH === 'string' ? env.PATH.split(':').filter((item) => isAbsolute(item)) : [];
    for (const name of commands ?? []) {
      if (typeof name !== 'string' || !name || name.includes('/')) continue;
      if (entries.some((entry) => isExecutable(join(entry, name)))) add(`PATH:${name}`);
    }
    // eslint-disable-next-line no-empty
  } catch {}
  return { detected: evidence.length > 0, evidence };
}
