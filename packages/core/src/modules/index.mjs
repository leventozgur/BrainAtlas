// SPDX-License-Identifier: MIT
import { readdir, realpath } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BrainAtlasError } from '../util/errors.mjs';

/** @typedef {{name:string,version:string,description:string,requires:string[],provides:string[],profiles:Array<'lite'|'full'|'custom'>,entry:string,experimental?:boolean}} ModuleManifest */
const profiles = new Set(['lite','full','custom']);
function manifestError(file) { return new BrainAtlasError('E_MODULE_MANIFEST', `Invalid module manifest in ${basename(file)}.`, { file: basename(file) }); }
function validString(value) { return typeof value === 'string' && value.trim().length > 0; }

/** @param {string} dir @returns {ModuleManifest} */
export function readModuleManifest(dir) {
  const file = resolve(dir, 'module.json'); let raw;
  try { raw = JSON.parse(readFileSync(file, 'utf8')); } catch { throw manifestError(file); }
  const keys = raw && typeof raw === 'object' && !Array.isArray(raw) ? Object.keys(raw) : [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || keys.some((key) => !['name','version','description','requires','provides','profiles','entry','experimental'].includes(key)) || !validString(raw.name) || !/^[a-z0-9][a-z0-9._-]*$/.test(raw.name) || !validString(raw.version) || !validString(raw.description) || !Array.isArray(raw.requires) || !raw.requires.every(validString) || !Array.isArray(raw.provides) || !raw.provides.every(validString) || !Array.isArray(raw.profiles) || !raw.profiles.every((profile) => profiles.has(profile)) || !raw.profiles.length || !validString(raw.entry) || raw.entry === '.' || isAbsolute(raw.entry) || raw.entry.split(/[\\/]/).includes('..') || raw.entry.includes('\\') || (raw.experimental !== undefined && typeof raw.experimental !== 'boolean')) throw manifestError(file);
  return { name: raw.name, version: raw.version, description: raw.description, requires: [...raw.requires], provides: [...raw.provides], profiles: [...raw.profiles], entry: raw.entry, ...(raw.experimental === undefined ? {} : { experimental: raw.experimental }) };
}

/** @param {string} releaseDir @returns {Promise<ModuleManifest[]>} */
export async function discoverModules(releaseDir) {
  let entries;
  try { entries = await readdir(resolve(releaseDir, 'modules'), { withFileTypes: true }); }
  catch (cause) { if (cause?.code === 'ENOENT') return []; throw new BrainAtlasError('E_MODULE_DISCOVERY', 'Could not discover modules.'); }
  const manifests = [];
  for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const dir = resolve(releaseDir, 'modules', entry.name);
    try { manifests.push(readModuleManifest(dir)); }
    catch (error) { if (error?.code === 'E_MODULE_MANIFEST') throw error; throw manifestError(resolve(dir, 'module.json')); }
  }
  return manifests;
}

/** @param {ModuleManifest[]} manifests @returns {ModuleManifest[]} */
export function resolveModuleOrder(manifests) {
  if (!Array.isArray(manifests)) throw new BrainAtlasError('E_MODULE_MANIFEST', 'Module list is invalid.');
  const byName = new Map();
  for (const manifest of manifests) {
    if (!manifest || !validString(manifest.name) || byName.has(manifest.name)) throw new BrainAtlasError('E_MODULE_MANIFEST', 'Module names must be valid and unique.');
    byName.set(manifest.name, manifest);
  }
  const state = new Map(); const ordered = []; const stack = [];
  function visit(name) {
    const mark = state.get(name);
    if (mark === 2) return;
    if (mark === 1) throw new BrainAtlasError('E_MODULE_CYCLE', 'Module dependency cycle detected.', { cycle: [...stack.slice(stack.indexOf(name)), name] });
    const manifest = byName.get(name);
    if (!manifest) throw new BrainAtlasError('E_MODULE_DEPENDENCY', 'A required module is missing.');
    state.set(name, 1); stack.push(name);
    for (const dependency of manifest.requires || []) {
      if (!byName.has(dependency)) throw new BrainAtlasError('E_MODULE_DEPENDENCY', `Module ${name} requires a missing module.`);
      visit(dependency);
    }
    stack.pop(); state.set(name, 2); ordered.push(manifest);
  }
  for (const manifest of manifests) visit(manifest.name);
  return ordered;
}

/** Activate a validated module entry, keeping the import inside its release directory. */
export async function activate(ctx) {
  if (!ctx?.moduleDir || !ctx?.manifest) throw new BrainAtlasError('E_MODULE_CONTEXT', 'Module activation context is incomplete.');
  const base = await realpath(resolve(ctx.moduleDir)); const target = resolve(base, ctx.manifest.entry); const rel = relative(base, target);
  if (!rel || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) throw new BrainAtlasError('E_MODULE_ENTRY', 'Module entry must remain inside its module directory.');
  const actual = await realpath(target); const actualRel = relative(base, actual);
  if (!actualRel || actualRel.startsWith(`..${sep}`) || actualRel === '..' || isAbsolute(actualRel)) throw new BrainAtlasError('E_MODULE_ENTRY', 'Module entry must remain inside its module directory.');
  const module = await import(pathToFileURL(actual).href);
  if (typeof module.activate !== 'function') throw new BrainAtlasError('E_MODULE_ENTRY', 'Module entry does not export activate.');
  await module.activate(ctx);
}

/** @type {Record<string, Function>} */
export const commands = Object.freeze({});
