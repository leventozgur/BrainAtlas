// SPDX-License-Identifier: MIT
import { lstat, readlink, realpath } from 'node:fs/promises';
import { dirname, join, resolve, relative, sep, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as core from '@brainatlas/core';
import { effectiveChannel, saveConfig, discoverModules, resolveModuleOrder, redact } from '@brainatlas/core';
import {
  recordManagedWrite,
  recordCreatedDirectories,
  missingDirectories,
  snapshotPath,
} from '../install-manifest.mjs';

export function adapterConfig(cfg, agent) {
  const map = cfg?.channels;
  if (!map || typeof map !== 'object' || !Object.hasOwn(map, agent)) return cfg;
  const copy = { ...cfg };
  if (effectiveChannel(cfg, agent) === 'cli') copy.channel = 'cli';
  else delete copy.channel;
  return copy;
}

export const error = (code, message, details = {}) => Object.assign(new Error(message), { code, ...details });
export const validVersion = (value) =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) && value !== '..';
export function managedRoots(paths, env) {
  const home = env.HOME;
  const platform = env.BRAINATLAS_PLATFORM || process.platform;
  const roots =
    platform === 'darwin'
      ? [home]
      : [
          home,
          join(home, '.local'),
          env.XDG_DATA_HOME || join(home, '.local', 'share'),
          env.XDG_CONFIG_HOME || join(home, '.config'),
          env.XDG_STATE_HOME || join(home, '.local', 'state'),
        ];
  return [...new Set(roots.filter((root) => typeof root === 'string' && root.length > 0))];
}
export async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
}
export async function readCurrent(paths) {
  let target;
  try {
    target = await readlink(paths.currentDir);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw error('E_CURRENT_INVALID', 'Current release link is invalid.');
  }
  if (target.startsWith('/') && target.startsWith(`${paths.releasesDir}/`))
    target = `releases/${target.slice(paths.releasesDir.length + 1)}`;
  const match = /^releases\/([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(target);
  if (!match || !validVersion(match[1])) throw error('E_CURRENT_INVALID', 'Current release link is invalid.');
  return target;
}
export function validateReleaseLink(target, allowNull = true) {
  if (target === null && allowNull) return null;
  if (
    typeof target !== 'string' ||
    !/^releases\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(target) ||
    !validVersion(target.slice('releases/'.length))
  )
    throw error('E_JOURNAL_INVALID', 'Update journal is invalid.');
  return target;
}
export function releaseSigner(paths, env) {
  return env.BRAINATLAS_ALLOWED_SIGNERS || join(paths.currentDir, 'release', 'allowed_signers');
}

export async function saveTrackedConfig(cfg, paths, env = process.env) {
  const home = env.HOME;
  const roots = managedRoots(paths, env);
  const created = home ? await missingDirectories(dirname(paths.configFile), home, roots) : [];
  const before = await snapshotPath(paths.configFile);
  await saveConfig(cfg, { paths });
  const after = await snapshotPath(paths.configFile);
  await recordManagedWrite(paths, paths.configFile, { before, after });
  if (created.length && home) await recordCreatedDirectories(paths, created, home, roots);
}

export function currentReleaseDir(paths, current) {
  return current ? join(paths.dataDir, current) : null;
}

export function redactOutput(value, home) {
  const redactString = (text) => {
    let result = home ? text.split(home).join('~') : text;
    result = result.replace(/\b([a-z][a-z0-9+.-]{0,31}:\/\/)([^\s/?#]*)/gi, (match, scheme, authority) => {
      const at = authority.lastIndexOf('@');
      return at < 0 ? match : `${scheme}[REDACTED]@${authority.slice(at + 1)}`;
    });
    return redact(result);
  };
  const visit = (item, key = '') => {
    if (
      /(?:password|passwd|passphrase|(?:^|[_ .-])pwd|secret|token|api[_ .-]?key|access[_ .-]?key|credential|private[_-]?key)/i.test(
        key
      )
    )
      return '[REDACTED]';
    if (typeof item === 'string') return redactString(item);
    if (Array.isArray(item)) return item.map((child) => visit(child));
    if (item && typeof item === 'object')
      return Object.fromEntries(Object.entries(item).map(([childKey, child]) => [childKey, visit(child, childKey)]));
    return item;
  };
  return visit(value);
}

export async function loadInstalledModuleEntry(releaseDir, manifest) {
  const releaseRoot = await realpath(releaseDir);
  const moduleDir = await realpath(join(releaseRoot, 'modules', manifest.name));
  const relativeModuleDir = relative(releaseRoot, moduleDir);
  if (
    !relativeModuleDir ||
    relativeModuleDir === '..' ||
    relativeModuleDir.startsWith(`..${sep}`) ||
    isAbsolute(relativeModuleDir)
  )
    throw error('E_MODULE_ENTRY', 'Module directory must remain inside its release.');
  const target = resolve(moduleDir, manifest.entry);
  const relativeTarget = relative(moduleDir, target);
  if (!relativeTarget || relativeTarget === '..' || relativeTarget.startsWith(`..${sep}`) || isAbsolute(relativeTarget))
    throw error('E_MODULE_ENTRY', 'Module entry must remain inside its module directory.');
  const actual = await realpath(target);
  const actualRelative = relative(moduleDir, actual);
  if (!actualRelative || actualRelative === '..' || actualRelative.startsWith(`..${sep}`) || isAbsolute(actualRelative))
    throw error('E_MODULE_ENTRY', 'Module entry must remain inside its module directory.');
  return import(pathToFileURL(actual).href);
}

export function providedTransportName(manifest) {
  for (const capability of manifest.provides || []) {
    const [family, name, ...extra] = capability.split(':');
    if (!name || extra.length || family.split('-').at(-1) !== 'transport') continue;
    return name;
  }
  return null;
}

export function moduleContext(config, paths, env, entries, ordered, dependencies = {}) {
  const registry = new Map();
  for (const manifest of ordered) {
    const entry = entries.get(manifest.name);
    registry.set(manifest.name, entry);
    for (const capability of manifest.provides || []) registry.set(capability, entry);
  }
  const logger = Object.freeze({
    info: (...values) => console.error(...values),
    warn: (...values) => console.error(...values),
    error: (...values) => console.error(...values),
  });
  return {
    config,
    paths,
    env,
    core,
    logger,
    registry,
    vaultDir: config.vault?.path,
    runCommand: dependencies.runCommand,
    fetchImpl: dependencies.fetch,
  };
}

export async function enabledModuleEntries(releaseDir, cfg) {
  const manifests = await discoverModules(releaseDir);
  const enabled = new Set(cfg.modules.includes('*') ? manifests.map((item) => item.name) : cfg.modules);
  const ordered = resolveModuleOrder(manifests.filter((item) => enabled.has(item.name)));
  const entries = new Map();
  for (const manifest of ordered) entries.set(manifest.name, await loadInstalledModuleEntry(releaseDir, manifest));
  return { ordered, entries };
}

export async function activateEnabledModules(ordered, entries, ctx) {
  for (const manifest of ordered) {
    const entry = entries.get(manifest.name);
    if (typeof entry?.activate !== 'function') throw error('E_MODULE_ENTRY', 'Module entry does not export activate.');
    await entry.activate(ctx);
  }
}
