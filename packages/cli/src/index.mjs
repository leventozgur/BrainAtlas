// SPDX-License-Identifier: MIT
import { readdir, access, mkdir, readFile, readlink, lstat, rename, rm, symlink, unlink, writeFile, chmod, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve, relative, sep, isAbsolute } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { spawnSync } from 'node:child_process';
import * as core from '@brainatlas/core';
import { defaultConfig, loadConfig, saveConfig, setConfigValue, resolvePaths, validateConfig, readModuleManifest, discoverModules, resolveModuleOrder, activate as activateModule, redact, vaultId } from '@brainatlas/core';
import { inspectReleaseArchive, extractVerifiedRelease } from './archive.mjs';
import { managePath, recordManagedWrite, recordCreatedDirectories, missingDirectories, removeCreatedDirectories, readInstallManifest, resolveManagedPath, snapshotPath, uninstallManagedFiles } from './install-manifest.mjs';
import { adoptPlan, migrateVault } from './migrate.mjs';

const error = (code, message, details = {}) => Object.assign(new Error(message), { code, ...details });
const builtInCommands = new Set(['init', 'install', 'status', 'doctor', 'config', 'module', 'uninstall', 'update', 'rollback', 'recover', 'eval', 'hook', 'mcp', 'migrate', 'adopt', 'help']);
const validVersion = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) && value !== '..';
function compareVersions(left, right) {
  const parse = value => /^(?:v)?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value);
  const a = parse(left); const b = parse(right);
  if (!a || !b) return left === right ? 0 : left < right ? -1 : 1;
  const aCore = a[1].split('.').map(Number); const bCore = b[1].split('.').map(Number);
  for (let index = 0; index < Math.max(aCore.length, bCore.length); index++) {
    const difference = (aCore[index] || 0) - (bCore[index] || 0); if (difference) return Math.sign(difference);
  }
  if (a[2] === undefined || b[2] === undefined) return a[2] === b[2] ? 0 : a[2] === undefined ? 1 : -1;
  const aPre = a[2].split('.'); const bPre = b[2].split('.');
  for (let index = 0; index < Math.max(aPre.length, bPre.length); index++) {
    if (aPre[index] === undefined || bPre[index] === undefined) return aPre[index] === bPre[index] ? 0 : aPre[index] === undefined ? -1 : 1;
    const an = /^\d+$/.test(aPre[index]); const bn = /^\d+$/.test(bPre[index]);
    if (an && bn && Number(aPre[index]) !== Number(bPre[index])) return Number(aPre[index]) < Number(bPre[index]) ? -1 : 1;
    if (an !== bn) return an ? -1 : 1;
    if (aPre[index] !== bPre[index]) return aPre[index] < bPre[index] ? -1 : 1;
  }
  return 0;
}
function managedRoots(paths, env) {
  const home = env.HOME; const platform = env.BRAINATLAS_PLATFORM || process.platform;
  const roots = platform === 'darwin'
    ? [home]
    : [home, join(home, '.local'), env.XDG_DATA_HOME || join(home, '.local', 'share'), env.XDG_CONFIG_HOME || join(home, '.config'), env.XDG_STATE_HOME || join(home, '.local', 'state')];
  return [...new Set(roots.filter(root => typeof root === 'string' && root.length > 0))];
}
const journalPath = paths => join(paths.stateDir, 'update-journal.json');
const previousPath = paths => join(paths.stateDir, 'previous-release');
const releaseLink = version => `releases/${version}`;

async function exists(path) { try { await lstat(path); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
async function writeJsonFile(file, value, paths = null, env = process.env) {
  const roots = paths ? managedRoots(paths, env) : [env.HOME];
  const created = paths ? await missingDirectories(dirname(file), env.HOME, roots) : [];
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}`;
  try { await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'w', mode: 0o600 }); await rename(temp, file); }
  catch { await rm(temp, { force: true }); throw error('E_STATE_WRITE', 'Could not write update state.'); }
  if (paths && created.length) await recordCreatedDirectories(paths, created, env.HOME, roots);
}
async function readCurrent(paths) {
  let target;
  try { target = await readlink(paths.currentDir); } catch (e) { if (e.code === 'ENOENT') return null; throw error('E_CURRENT_INVALID', 'Current release link is invalid.'); }
  if (target.startsWith('/') && target.startsWith(`${paths.releasesDir}/`)) target = `releases/${target.slice(paths.releasesDir.length + 1)}`;
  const match = /^releases\/([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(target);
  if (!match || !validVersion(match[1])) throw error('E_CURRENT_INVALID', 'Current release link is invalid.');
  return target;
}
function validateReleaseLink(target, allowNull = true) {
  if (target === null && allowNull) return null;
  if (typeof target !== 'string' || !/^releases\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(target) || !validVersion(target.slice('releases/'.length))) throw error('E_JOURNAL_INVALID', 'Update journal is invalid.');
  return target;
}
async function switchCurrent(paths, target) {
  const before = await snapshotPath(paths.currentDir);
  const currentExists = await exists(paths.currentDir);
  if (currentExists) {
    const stat = await lstat(paths.currentDir);
    if (!stat.isSymbolicLink()) throw error('E_CURRENT_INVALID', 'Current release path is not a symbolic link.');
  }
  if (target !== null) {
    validateReleaseLink(target, false);
    let releaseStat;
    try { releaseStat = await lstat(join(paths.dataDir, target)); } catch { throw error('E_RELEASE_MISSING', 'Requested release is unavailable.'); }
    if (!releaseStat.isDirectory() || releaseStat.isSymbolicLink()) throw error('E_RELEASE_INVALID', 'Requested release is invalid.');
  }
  await mkdir(paths.dataDir, { recursive: true });
  const temp = `${paths.currentDir}.next-${process.pid}`;
  await rm(temp, { force: true });
  try {
    if (target === null) await rm(paths.currentDir, { force: true });
    else { await symlink(target, temp); await rename(temp, paths.currentDir); }
  } catch { await rm(temp, { force: true }); throw error('E_CURRENT_SWITCH', 'Could not switch the current release.'); }
  const after = await snapshotPath(paths.currentDir);
  await recordManagedWrite(paths, paths.currentDir, { before, after });
}
async function savePrevious(paths, target, env = process.env) {
  if (target === null) { await rm(previousPath(paths), { force: true }); return; }
  validateReleaseLink(target, false);
  const roots = managedRoots(paths, env); const created = await missingDirectories(paths.stateDir, env.HOME, roots);
  await mkdir(paths.stateDir, { recursive: true });
  await writeFile(previousPath(paths), `${target}\n`, { mode: 0o600 });
  if (created.length) await recordCreatedDirectories(paths, created, env.HOME, roots);
}
async function readPrevious(paths) {
  try { return validateReleaseLink((await readFile(previousPath(paths), 'utf8')).trim(), false); }
  catch (e) { if (e.code === 'ENOENT') return null; if (e.code === 'E_JOURNAL_INVALID') throw e; throw error('E_STATE_READ', 'Could not read release state.'); }
}
async function readJournal(paths) {
  try {
    const value = JSON.parse(await readFile(journalPath(paths), 'utf8'));
    if (value?.schemaVersion !== 1 || !['update', 'rollback'].includes(value.kind) || !['extracting', 'prepared', 'switching', 'switched', 'complete', 'rolled-back'].includes(value.phase)) throw new Error();
    validateReleaseLink(value.target, false); validateReleaseLink(value.previous, true);
    if (value.staging !== null && (typeof value.staging !== 'string' || !/^releases\/\.staging-[A-Za-z0-9._-]+$/.test(value.staging))) throw new Error();
    return value;
  } catch (e) { if (e.code === 'ENOENT') return null; throw error('E_JOURNAL_INVALID', 'Update journal is invalid.'); }
}
async function clearJournal(paths) { await rm(journalPath(paths), { force: true }); }
async function doctorResult(paths, env) {
  let cfg; let configOk = true;
  try { cfg = await loadConfig({ paths, env }); configOk = validateConfig(cfg).ok; }
  catch { cfg = defaultConfig('lite'); configOk = false; }
  const checks = { config: configOk };
  try { await access(paths.currentDir); checks.release = true; } catch { checks.release = false; }
  const warnings = []; const moduleHealth = [];
  if (checks.release && cfg.agents?.length) {
    const adapterRoot = fileURLToPath(new URL('../../adapters/', import.meta.url));
    for (const agent of cfg.agents) {
      try {
        const adapter = await import(pathToFileURL(join(adapterRoot, agent, 'src/index.mjs')).href);
        if (typeof adapter.doctor === 'function') checks[`adapter:${agent}`] = Boolean((await adapter.doctor({ env, config: cfg, paths, scope: cfg.scope, nodePath: cfg.node.path, shimPath: paths.binPath, now: new Date() }))?.ok);
        else warnings.push(`Adapter ${agent} has no health check.`);
      } catch (cause) {
        if (cause?.code === 'ERR_MODULE_NOT_FOUND' || cause?.code === 'E_NOT_IMPLEMENTED') warnings.push(`Adapter ${agent} is unavailable.`);
        else checks[`adapter:${agent}`] = false;
      }
    }
  }
  if (checks.release && cfg.modules?.length) {
    try {
      const current = await readCurrent(paths); const releaseDir = currentReleaseDir(paths, current);
      if (releaseDir) {
        const { ordered, entries } = await enabledModuleEntries(releaseDir, cfg);
        const ctx = moduleContext(cfg, paths, env, entries, ordered);
        await activateEnabledModules(ordered, entries, ctx);
        const syncModule = ordered.find(item => (item.provides || []).includes('sync'));
        if (syncModule) {
          let sync = null;
          try { sync = await entries.get(syncModule.name)?.commands?.status?.(ctx); }
          catch { warnings.push('Sync health is unavailable.'); }
          let lastSync = null;
          try {
            const manifest = JSON.parse(await readFile(join(paths.stateDir, 'sync', 'last-synced-manifest.json'), 'utf8'));
            if (typeof manifest.generatedAt === 'string') lastSync = manifest.generatedAt;
          } catch { /* No successful sync has been recorded. */ }
          moduleHealth.push({ name: 'sync', transport: cfg.sync?.transport ?? null, status: sync?.status ?? 'unknown', lastSync });
        }
        if (ordered.some(item => item.name === 'semantic')) {
          let freshness = null;
          try {
            const semantic = entries.get('semantic'); const index = await semantic?.readSemanticIndex?.(paths.stateDir);
            freshness = index ? await semantic.measureIndexFreshness({ corpusDir: cfg.vault.path, index }) : null;
            if (!index) warnings.push('Semantic index is not available.');
          } catch { warnings.push('Semantic index freshness is unavailable.'); }
          moduleHealth.push({ name: 'semantic', freshness });
        }
      }
    } catch { warnings.push('Module health summary is unavailable.'); }
  }
  if (env.BRAINATLAS_TEST_DOCTOR_FAIL === '1') checks.injected = false;
  return { ok: Object.values(checks).every(Boolean), checks, profile: cfg.profile, modules: cfg.modules, moduleHealth, warnings };
}
async function removeAdapters(cfg, paths, env) {
  const adapterRoot = fileURLToPath(new URL('../../adapters/', import.meta.url)); const warnings = [];
  for (const agent of cfg.agents || []) {
    try {
      const adapter = await import(pathToFileURL(join(adapterRoot, agent, 'src/index.mjs')).href);
      if (typeof adapter.remove !== 'function') { warnings.push(`Adapter ${agent} has no remove operation.`); continue; }
      const ctx = { env, config: cfg, paths, scope: cfg.scope, nodePath: cfg.node.path, shimPath: paths.binPath, now: new Date() };
      const planned = typeof adapter.plan === 'function' ? await adapter.plan(ctx) : { changes: [] };
      const managed = new Map();
      const manifest = await readInstallManifest(paths);
      for (const entry of manifest.files) {
        if (entry.owners?.includes(agent)) managed.set(entry.path, await snapshotPath(entry.path));
      }
      for (const change of planned?.changes || []) {
        const file = resolve(change.file);
        if (!managed.has(file)) managed.set(file, await snapshotPath(file));
      }
      const knownNames = new Map();
      for (const file of managed.keys()) {
        const parent = dirname(file);
        if (!knownNames.has(parent)) knownNames.set(parent, new Set(await readdir(parent).catch(cause => { if (cause.code === 'ENOENT') return []; throw cause; })));
      }
      await adapter.remove(ctx);
      for (const [file, before] of managed) {
        const after = await snapshotPath(file);
        if (before?.sha256 !== after?.sha256 || before?.kind !== after?.kind || before?.mode !== after?.mode) {
          await recordManagedWrite(paths, file, { before, after, owner: agent });
        }
        const parent = dirname(file); const known = knownNames.get(parent) || new Set();
        for (const name of await readdir(parent).catch(cause => { if (cause.code === 'ENOENT') return []; throw cause; })) {
          if (!name.startsWith(`${basename(file)}.bak.`) || known.has(name)) continue;
          const backup = join(parent, name);
          await recordManagedWrite(paths, backup, { before: null, after: await snapshotPath(backup), owner: agent, role: 'adapter-backup' });
        }
      }
    } catch (cause) {
      if (cause?.code === 'E_NOT_IMPLEMENTED' || cause?.code === 'ERR_MODULE_NOT_FOUND') warnings.push(`Adapter ${agent} is unavailable.`);
      else throw cause;
    }
  }
  return warnings;
}
function checkCurrentRelease(paths, env) {
  const cli = join(paths.currentDir, 'packages', 'cli', 'bin', 'brainatlas.mjs');
  const result = spawnSync(process.execPath, [cli, 'doctor', '--json'], { env, encoding: 'utf8', timeout: 15000 });
  let report;
  try { report = JSON.parse(result.stdout || ''); } catch { report = null; }
  if (!report || typeof report.ok !== 'boolean') return { ok: false, checks: { doctor: false } };
  if (result.error || result.status !== 0) report.ok = false;
  return report;
}
function releaseSigner(paths, env) { return env.BRAINATLAS_ALLOWED_SIGNERS || join(paths.currentDir, 'release', 'allowed_signers'); }

async function saveTrackedConfig(cfg, paths, env = process.env) {
  const home = env.HOME;
  const roots = managedRoots(paths, env); const created = home ? await missingDirectories(dirname(paths.configFile), home, roots) : [];
  const before = await snapshotPath(paths.configFile);
  await saveConfig(cfg, { paths });
  const after = await snapshotPath(paths.configFile);
  await recordManagedWrite(paths, paths.configFile, { before, after });
  if (created.length && home) await recordCreatedDirectories(paths, created, home, roots);
}

function shellQuote(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }

function setCliConfigValue(cfg, dottedKey, value) {
  const keys = dottedKey.split('.');
  if (keys.length <= 2) return setConfigValue(cfg, dottedKey, value);
  const updated = structuredClone(cfg); let target = updated;
  for (const key of keys.slice(0, -1)) {
    if (!target[key] || typeof target[key] !== 'object' || Array.isArray(target[key])) throw error('E_CONFIG_KEY', `Unknown configuration key ${dottedKey}.`);
    target = target[key];
  }
  target[keys.at(-1)] = structuredClone(value);
  const validation = validateConfig(updated);
  if (!validation.ok) throw error('E_CONFIG_INVALID', 'Configuration is invalid.', validation.errors);
  return updated;
}

async function writeInstallEntrypoints(paths, env) {
  const shim = paths.binPath; const localBin = join(env.HOME, '.local', 'bin');
  const roots = managedRoots(paths, env);
  const created = [...await missingDirectories(dirname(shim), env.HOME, roots), ...await missingDirectories(localBin, env.HOME, roots)];
  const cli = join(paths.currentDir, 'packages', 'cli', 'bin', 'brainatlas.mjs');
  const shimContent = `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(cli)} "$@"\n`;
  await recordManagedWrite(paths, paths.currentDir, { before: null, after: await snapshotPath(paths.currentDir) });
  await mkdir(dirname(shim), { recursive: true });
  await managePath(paths, shim, async () => {
    await rm(shim, { force: true });
    await writeFile(shim, shimContent, { mode: 0o755 });
    await chmod(shim, 0o755);
  });
  await mkdir(localBin, { recursive: true });
  for (const name of ['brainatlas', 'ba']) {
    const link = join(localBin, name);
    await managePath(paths, link, async () => { await rm(link, { force: true }); await symlink(shim, link); });
  }
  if (created.length) await recordCreatedDirectories(paths, created, env.HOME, roots);
}

async function removeAppDataPreserving(paths, keepFiles = [], vaultPath = null) {
  const dataDir = await resolveManagedPath(paths.dataDir, { followFinal: true });
  const keep = new Set(await Promise.all(keepFiles.map(path => resolveManagedPath(resolve(path), { followFinal: true }))));
  if (vaultPath) keep.add(await resolveManagedPath(resolve(vaultPath), { followFinal: true }));
  try { const stat = await lstat(paths.dataDir); if (!stat.isDirectory() || stat.isSymbolicLink()) throw error('E_UNINSTALL_CONFLICT', `Application data directory is unsafe: ${paths.dataDir}.`, { path: paths.dataDir, conflicts: [paths.dataDir] }); }
  catch (cause) { if (cause?.code === 'ENOENT') return; throw cause; }
  async function removeTree(dir) {
    const entries = await readdir(dir, { withFileTypes: true }).catch(cause => { if (cause.code === 'ENOENT') return null; throw cause; });
    if (!entries) return false;
    let retained = false;
    for (const entry of entries) {
      const file = join(dir, entry.name);
      const preservesSubtree = [...keep].some(path => path === file || path.startsWith(`${file}${sep}`));
      const insidePreservedPath = [...keep].some(path => file === path || file.startsWith(`${path}${sep}`));
      if (insidePreservedPath) { retained = true; continue; }
      if (preservesSubtree) {
        if (entry.isDirectory() && !entry.isSymbolicLink()) retained = (await removeTree(file)) || retained;
        else retained = true;
      } else await rm(file, { recursive: true, force: true });
    }
    const exact = keep.has(dir);
    if (!retained && !exact) await rm(dir, { recursive: true, force: true });
    return retained || exact;
  }
  await removeTree(dataDir);
}

export async function hookCommandFor({ client, event, paths, config }) {
  if (!['claude', 'codex', 'kiro', 'copilot', 'gemini'].includes(client) || !['prompt', 'session-start', 'session-end'].includes(event)) throw error('E_HOOK_CLIENT', 'Hook client or event is invalid.');
  let component;
  try { component = await import('@brainatlas/hooks'); }
  catch (cause) { if (cause.code === 'ERR_MODULE_NOT_FOUND') throw error('E_COMPONENT_MISSING', 'Hook component is unavailable.'); throw cause; }
  if (typeof component.buildHookCommand !== 'function') throw error('E_COMPONENT_MISSING', 'Hook command builder is unavailable.');
  const state = join(paths.stateDir, vaultId(config.vault.path));
  await mkdir(state, { recursive: true });
  return component.buildHookCommand({ nodePath: process.execPath, shimPath: paths.binPath, client, event, paths: { vault: config.vault.path, state, release: paths.currentDir, configFile: paths.configFile } });
}

async function recoverUpdate(paths, env) {
  const journal = await readJournal(paths);
  if (!journal) return { recovered: false };
  const target = validateReleaseLink(journal.target, false); const previous = validateReleaseLink(journal.previous, true);
  if (journal.phase === 'extracting' || journal.phase === 'prepared') {
    if (journal.staging) await rm(join(paths.dataDir, journal.staging), { recursive: true, force: true });
    await clearJournal(paths);
    return { recovered: true, action: 'discarded-incomplete-update' };
  }
  if (journal.phase === 'switching' || journal.phase === 'rolled-back') {
    const restore = journal.kind === 'rollback' && journal.phase === 'switching' ? target : previous;
    await switchCurrent(paths, restore);
    if (journal.kind === 'rollback' && journal.phase === 'switching') await savePrevious(paths, previous, env);
    await clearJournal(paths);
    return { recovered: true, action: journal.kind === 'rollback' && journal.phase === 'switching' ? 'completed-rollback' : 'restored-previous-release' };
  }
  if (journal.phase === 'switched') {
    if (journal.kind === 'rollback') {
      await switchCurrent(paths, target); await savePrevious(paths, previous, env); await clearJournal(paths);
      return { recovered: true, action: 'completed-rollback' };
    }
    await switchCurrent(paths, target);
    const health = checkCurrentRelease(paths, env);
    if (!health.ok) {
      await switchCurrent(paths, previous);
      await clearJournal(paths);
      return { recovered: true, action: 'rolled-back-after-doctor', doctor: health };
    }
    await savePrevious(paths, previous, env); await clearJournal(paths);
    return { recovered: true, action: 'completed-update', doctor: health };
  }
  await switchCurrent(paths, target);
  await savePrevious(paths, previous, env); await clearJournal(paths);
  return { recovered: true, action: 'completed-update' };
}

function currentReleaseDir(paths, current) { return current ? join(paths.dataDir, current) : null; }

function redactOutput(value, home) {
  const redactString = text => {
    let result = home ? text.split(home).join('~') : text;
    // The core redactor catches user:password@, but URL userinfo can also be
    // username-only. Remove the entire userinfo component for every URL form.
    result = result.replace(/\b([a-z][a-z0-9+.-]{0,31}:\/\/)([^\s/?#]*)/gi, (match, scheme, authority) => {
      const at = authority.lastIndexOf('@');
      return at < 0 ? match : `${scheme}[REDACTED]@${authority.slice(at + 1)}`;
    });
    return redact(result);
  };
  const visit = (item, key = '') => {
    if (/(?:password|passwd|passphrase|(?:^|[_ .-])pwd|secret|token|api[_ .-]?key|access[_ .-]?key|credential|private[_-]?key)/i.test(key)) return '[REDACTED]';
    if (typeof item === 'string') return redactString(item);
    if (Array.isArray(item)) return item.map(child => visit(child));
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([childKey, child]) => [childKey, visit(child, childKey)]));
    return item;
  };
  return visit(value);
}

async function loadInstalledModuleEntry(releaseDir, manifest) {
  const releaseRoot = await realpath(releaseDir);
  const moduleDir = await realpath(join(releaseRoot, 'modules', manifest.name));
  const relativeModuleDir = relative(releaseRoot, moduleDir);
  if (!relativeModuleDir || relativeModuleDir === '..' || relativeModuleDir.startsWith(`..${sep}`) || isAbsolute(relativeModuleDir)) throw error('E_MODULE_ENTRY', 'Module directory must remain inside its release.');
  const target = resolve(moduleDir, manifest.entry);
  const relativeTarget = relative(moduleDir, target);
  if (!relativeTarget || relativeTarget === '..' || relativeTarget.startsWith(`..${sep}`) || isAbsolute(relativeTarget)) throw error('E_MODULE_ENTRY', 'Module entry must remain inside its module directory.');
  const actual = await realpath(target);
  const actualRelative = relative(moduleDir, actual);
  if (!actualRelative || actualRelative === '..' || actualRelative.startsWith(`..${sep}`) || isAbsolute(actualRelative)) throw error('E_MODULE_ENTRY', 'Module entry must remain inside its module directory.');
  return import(pathToFileURL(actual).href);
}

function providedTransportName(manifest) {
  for (const capability of manifest.provides || []) {
    const [family, name, ...extra] = capability.split(':');
    if (!name || extra.length || family.split('-').at(-1) !== 'transport') continue;
    return name;
  }
  return null;
}

function moduleContext(config, paths, env, entries, ordered) {
  const registry = new Map();
  for (const manifest of ordered) {
    const entry = entries.get(manifest.name);
    registry.set(manifest.name, entry);
    for (const capability of manifest.provides || []) registry.set(capability, entry);
  }
  const logger = Object.freeze({
    info: (...values) => console.log(...values),
    warn: (...values) => console.error(...values),
    error: (...values) => console.error(...values)
  });
  return { config, paths, env, core, logger, registry, vaultDir: config.vault?.path };
}

async function enabledModuleEntries(releaseDir, cfg) {
  const manifests = await discoverModules(releaseDir);
  const enabled = new Set(cfg.modules.includes('*') ? manifests.map(item => item.name) : cfg.modules);
  const ordered = resolveModuleOrder(manifests.filter(item => enabled.has(item.name)));
  const entries = new Map();
  for (const manifest of ordered) entries.set(manifest.name, await loadInstalledModuleEntry(releaseDir, manifest));
  return { ordered, entries };
}

async function activateEnabledModules(ordered, entries, ctx) {
  for (const manifest of ordered) {
    const entry = entries.get(manifest.name);
    if (typeof entry?.activate !== 'function') throw error('E_MODULE_ENTRY', 'Module entry does not export activate.');
    await entry.activate(ctx);
  }
}

async function queueSessionEndReceipt({ client, hookInput, config, paths, env }) {
  const operation = (async () => {
    const current = await readCurrent(paths);
    const releaseDir = currentReleaseDir(paths, current);
    if (!releaseDir) return;
    const { ordered, entries } = await enabledModuleEntries(releaseDir, config);
    const handler = ordered.map(manifest => entries.get(manifest.name)).find(entry => typeof entry?.onSessionEnd === 'function');
    if (!handler) return;
    const ctx = moduleContext(config, paths, env, entries, ordered);
    await activateEnabledModules(ordered, entries, ctx);
    await handler.onSessionEnd(ctx, { ...hookInput, client });
  })();
  let timer;
  const deadline = Math.max(1, Number(config.hooks?.deadlineMs) || 1000);
  try {
    return await Promise.race([
      operation.then(() => true, () => false),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), deadline); })
    ]);
  } finally { clearTimeout(timer); }
}

async function dispatchModuleCommand(command, args, { paths, env, output }) {
  const current = await readCurrent(paths);
  const releaseDir = currentReleaseDir(paths, current);
  if (!releaseDir) throw error('E_COMMAND_UNKNOWN', 'Unknown command.');
  const cfg = await loadConfig({ paths, env });
  const { ordered, entries } = await enabledModuleEntries(releaseDir, cfg);
  let owner; let ownerCommand = command; let ownerArgs = args;
  if (command === 'sync' && args.length) {
    const transportName = args[0];
    const transport = ordered.find(manifest => providedTransportName(manifest) === transportName);
    if (transport) {
      owner = transport;
      const entry = entries.get(transport.name);
      const action = args[1];
      if (typeof entry.commands?.[transportName] === 'function') {
        ownerCommand = transportName; ownerArgs = args.slice(1);
      } else if (action && typeof entry.commands?.[action] === 'function') {
        ownerCommand = action; ownerArgs = args.slice(2);
      } else if (typeof entry.commands?.sync === 'function') {
        ownerCommand = 'sync'; ownerArgs = args;
      } else {
        throw error('E_COMMAND_UNKNOWN', 'Unknown command.');
      }
    }
  }
  for (const manifest of ordered) {
    if (owner) break;
    const entry = entries.get(manifest.name);
    if (entry.commands && Object.hasOwn(entry.commands, command) && typeof entry.commands[command] === 'function') {
      owner = manifest;
      break;
    }
  }
  if (!owner) throw error('E_COMMAND_UNKNOWN', 'Unknown command.');
  const ctx = moduleContext(cfg, paths, env, entries, ordered);
  await activateEnabledModules(ordered, entries, ctx);
  const commandEntry = entries.get(owner.name).commands[ownerCommand];
  let result;
  try { result = await commandEntry(ownerArgs, ctx); }
  catch (cause) {
    if (cause?.code !== 'E_ARGUMENT' || !ownerArgs.includes('--json')) throw cause;
    result = await commandEntry(ownerArgs.filter(argument => argument !== '--json'), ctx);
  }
  if (result && typeof result === 'object' && Number.isInteger(result.exitCode) && typeof result.output === 'string') {
    if (result.output) console.log(result.output);
    process.exitCode = result.exitCode;
  } else if (result !== undefined) output(result);
}

const helpDescriptions = Object.freeze({
  init: 'Create a BrainAtlas configuration and initialize a vault.', install: 'Install a BrainAtlas release.', status: 'Show installation status.',
  doctor: 'Check installation health.', config: 'Read or change BrainAtlas configuration.', module: 'List, add, or remove installed modules.',
  uninstall: 'Remove BrainAtlas while preserving the vault.', update: 'Install or inspect a release update.', rollback: 'Switch to a previous release.',
  recover: 'Inspect or recover an interrupted update.', eval: 'Run the local retrieval evaluation.', hook: 'Run an agent hook.', mcp: 'Start the BrainAtlas MCP server.',
  migrate: 'Copy vault content into a new vault. bodyHashMatch compares wiki page bodies except wiki/log.md; logPrefixPreserved confirms the exact source log bytes prefix the target log; logAppendedEntries is the number of migration log entries appended.', adopt: 'Inspect existing agent setup and propose adoption.', help: 'Show built-in and active module commands.'
});
const helpUsages = Object.freeze({
  init: 'brainatlas init [--yes] [--vault PATH] [--profile lite|full] [--agents claude-code,copilot-vscode,kiro,codex,gemini-cli] [--plan] [--json]', install: 'brainatlas install [--finalize]', status: 'brainatlas status [--json]', doctor: 'brainatlas doctor [--json]',
  config: 'brainatlas config get [KEY] | set KEY VALUE [--plan]', module: 'brainatlas module list | add NAME --from ARCHIVE | remove NAME [--plan]',
  uninstall: 'brainatlas uninstall [--plan]', update: 'brainatlas update --from ARCHIVE [--plan] | --check', rollback: 'brainatlas rollback [--to VERSION] [--plan]',
  recover: 'brainatlas recover [--plan]', eval: 'brainatlas eval [--cases FILE] [--corpus DIR]', hook: 'brainatlas hook CLIENT EVENT', mcp: 'brainatlas mcp',
  migrate: 'brainatlas migrate --from OLD_VAULT --to NEW_VAULT [--plan] [--json]', adopt: 'brainatlas adopt --plan [--json]', help: 'brainatlas --help | brainatlas help [COMMAND]'
});

async function availableHelpCommands(paths, env) {
  const commands = [...builtInCommands].map(name => ({ name, kind: 'built-in', usage: helpUsages[name], description: helpDescriptions[name] }));
  const current = await readCurrent(paths).catch(() => null);
  const releaseDir = currentReleaseDir(paths, current);
  if (releaseDir) {
    let cfg; try { cfg = await loadConfig({ paths, env }); } catch { cfg = defaultConfig('lite'); }
    try {
      const { ordered, entries } = await enabledModuleEntries(releaseDir, cfg);
      const seen = new Set(commands.map(item => item.name));
      const moduleHelp = new Map();
      for (const manifest of ordered) {
        const entry = entries.get(manifest.name);
        for (const [name, help] of Object.entries(entry?.help || {})) {
          if (!moduleHelp.has(name)) moduleHelp.set(name, { usage: [], description: help?.description });
          const target = moduleHelp.get(name);
          for (const line of Array.isArray(help?.usage) ? help.usage : help?.usage ? [help.usage] : []) {
            if (!target.usage.includes(line)) target.usage.push(line);
          }
          if (!target.description && help?.description) target.description = help.description;
        }
        const transportName = providedTransportName(manifest);
        if (transportName && typeof entry?.commands?.status === 'function') {
          if (!moduleHelp.has('sync')) moduleHelp.set('sync', { usage: [] });
          moduleHelp.get('sync').usage.push(`brainatlas sync ${transportName} status [--json]`);
        }
        for (const name of Object.keys(entry?.commands || {}).sort()) {
          if (seen.has(name)) continue;
          seen.add(name);
          const help = moduleHelp.get(name);
          const usage = help?.usage?.length ? help.usage : [`brainatlas ${name} [ARGS]`];
          commands.push({ name, kind: 'module', module: manifest.name, usage: usage.length === 1 ? usage[0] : usage, description: help?.description || `Command provided by the ${manifest.name} module.` });
        }
      }
      // A transport module may add subcommands to sync without owning a top-level command.
      const sync = commands.find(item => item.name === 'sync');
      const syncHelp = moduleHelp.get('sync');
      if (sync && syncHelp?.usage?.length) {
        const existing = Array.isArray(sync.usage) ? sync.usage : [sync.usage];
        const usage = [...existing];
        for (const line of syncHelp.usage) if (!usage.includes(line)) usage.push(line);
        sync.usage = usage;
      }
    } catch { /* Help remains usable when an installed module is damaged. */ }
  }
  return commands.sort((a, b) => a.name.localeCompare(b.name));
}

async function showHelp(topic, { paths, env, output, json }) {
  const commands = await availableHelpCommands(paths, env);
  if (topic) {
    const command = commands.find(item => item.name === topic);
    if (!command && topic === 'sync') {
      const moduleName = ['sync', 'engine'].join('-');
      const description = `sync is provided by the Full profile modules; install/enable ${moduleName}`;
      output(json ? { name: 'sync', kind: 'unavailable', usage: '', description } : description); return;
    }
    if (!command) throw error('E_COMMAND_UNKNOWN', 'Unknown command.');
    const usage = Array.isArray(command.usage) ? command.usage.join('\n') : command.usage;
    output(json ? command : `${usage}\n${command.description}`); return;
  }
  const result = { commands };
  const lines = ['BrainAtlas commands:', ...commands.map(item => `  ${item.name.padEnd(14)} ${item.description}`), '', 'Run "brainatlas help <command>" for command usage.'];
  output(json ? result : lines.join('\n'));
}

function validateArchiveModule(manifest, name) {
  const allowed = new Set(['name', 'version', 'description', 'requires', 'provides', 'profiles', 'entry', 'experimental']);
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || Object.keys(manifest).some(key => !allowed.has(key)) || manifest.name !== name || !/^[a-z0-9][a-z0-9._-]*$/.test(manifest.name) || typeof manifest.version !== 'string' || !manifest.version.trim() || typeof manifest.description !== 'string' || !manifest.description.trim() || !Array.isArray(manifest.requires) || !manifest.requires.every(item => typeof item === 'string' && /^[a-z0-9][a-z0-9._-]*$/.test(item)) || !Array.isArray(manifest.provides) || !manifest.provides.every(item => typeof item === 'string' && item.trim()) || !Array.isArray(manifest.profiles) || !manifest.profiles.length || !manifest.profiles.every(item => ['lite', 'full', 'custom'].includes(item)) || typeof manifest.entry !== 'string' || !manifest.entry || manifest.entry === '.' || manifest.entry.startsWith('/') || manifest.entry.includes('\\') || manifest.entry.split('/').some(part => !part || part === '.' || part === '..') || (manifest.experimental !== undefined && typeof manifest.experimental !== 'boolean')) throw error('E_MODULE_MANIFEST', 'Module manifest is invalid.');
  return manifest;
}

async function moduleCommand(args, { paths, env, output, plan, value }) {
  const action = args.shift();
  if (!['add', 'remove', 'list'].includes(action)) throw error('E_ARGUMENT', 'Module action is invalid.');
  const name = action === 'list' ? undefined : args.shift();
  if (name && !/^[a-z0-9][a-z0-9._-]*$/.test(name)) throw error('E_ARGUMENT', 'Module name is invalid.');
  const current = await readCurrent(paths); const releaseDir = currentReleaseDir(paths, current);
  if (!releaseDir) throw error('E_RELEASE_MISSING', 'No release is installed.');
  const cfg = await loadConfig({ paths, env });
  if (action === 'list') {
    const manifests = await discoverModules(releaseDir);
    const enabled = new Set(cfg.modules.includes('*') ? manifests.map(item => item.name) : cfg.modules);
    output({ modules: manifests.map(item => ({ name: item.name, version: item.version, active: enabled.has(item.name) })) });
    return;
  }
  if (action === 'remove') {
    const directory = join(releaseDir, 'modules', name);
    if (!(await exists(directory))) throw error('E_MODULE_MISSING', 'Module is not installed.');
    const manifest = readModuleManifest(directory);
    const manifests = await discoverModules(releaseDir);
    const remaining = manifests.filter(item => item.name !== name && (cfg.modules.includes('*') || cfg.modules.includes(item.name)));
    if (remaining.some(item => item.requires.includes(name))) throw error('E_MODULE_DEPENDENCY', 'Another enabled module requires this module.');
    const modules = cfg.modules.includes('*') ? remaining.map(item => item.name) : cfg.modules.filter(item => item !== name);
    if (plan) { output({ action: 'module remove', name, modules }); return; }
    await rm(directory, { recursive: true, force: true });
    const updated = setConfigValue(cfg, 'modules', modules);
    await saveTrackedConfig(updated, paths, env);
    output({ action: 'module remove', name }); return;
  }
  const archive = value('--from');
  if (!archive) throw error('E_ARGUMENT', 'module add requires --from <full.tgz>.');
  const { manifest: release, files, prefix } = await inspectReleaseArchive(resolve(archive), releaseSigner(paths, env));
  if (release.profile !== 'full') throw error('E_PROFILE_MISMATCH', 'Modules can only be added from a full release.');
  const modulePrefix = `${prefix}modules/${name}/`;
  const moduleBytes = files.get(`${modulePrefix}module.json`);
  if (!moduleBytes || !release.modules.includes(name)) throw error('E_MODULE_MISSING', 'Module is missing from the full release.');
  const manifests = new Map();
  const collect = moduleName => {
    if (manifests.has(moduleName)) return;
    const bytes = files.get(`${prefix}modules/${moduleName}/module.json`);
    if (!bytes || !release.modules.includes(moduleName)) throw error('E_MODULE_DEPENDENCY', 'A required module is missing from the full release.');
    let parsed; try { parsed = JSON.parse(bytes.toString('utf8')); } catch { throw error('E_MODULE_MANIFEST', 'Module manifest is invalid.'); }
    const validated = validateArchiveModule(parsed, moduleName); manifests.set(moduleName, validated);
    for (const dependency of validated.requires) collect(dependency);
  };
  collect(name);
  const ordered = resolveModuleOrder([...manifests.values()]);
  const existing = new Set(await readdir(join(releaseDir, 'modules')).catch(cause => { if (cause.code === 'ENOENT') return []; throw cause; }));
  const installNames = ordered.map(item => item.name).filter(item => !existing.has(item));
  if (existing.has(name)) throw error('E_MODULE_EXISTS', 'Module is already installed.');
  const cfgModules = new Set(cfg.modules);
  const nextModules = cfg.modules.includes('*') ? cfg.modules : [...cfg.modules, ...ordered.map(item => item.name).filter(item => !cfgModules.has(item))];
  if (plan) { output({ action: 'module add', modules: installNames, configModules: nextModules }); return; }
  const installedDirs = []; let activationConfig = cfg;
  try {
    for (const moduleName of installNames) {
      const destination = join(releaseDir, 'modules', moduleName); await mkdir(destination, { recursive: true }); installedDirs.push(destination);
      const sourcePrefix = `${prefix}modules/${moduleName}/`;
      for (const [archiveName, bytes] of files) {
        if (!archiveName.startsWith(sourcePrefix)) continue;
        const relativeName = archiveName.slice(sourcePrefix.length);
        if (!relativeName || relativeName.split('/').some(part => !part || part === '.' || part === '..')) throw error('E_MANIFEST_INVALID', 'Module path is invalid.');
        const target = join(destination, relativeName); await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes, { flag: 'wx', mode: 0o644 });
      }
    }
    if (!cfg.modules.includes('*')) { activationConfig = setConfigValue(cfg, 'modules', nextModules); await saveTrackedConfig(activationConfig, paths, env); }
    const logger = Object.freeze({ info() {}, warn() {}, error() {} }); const warnings = [];
    for (const moduleManifest of ordered) {
      if (!installNames.includes(moduleManifest.name)) continue;
      try { await activateModule({ moduleDir: join(releaseDir, 'modules', moduleManifest.name), manifest: moduleManifest, config: activationConfig, paths, env, core: {}, logger }); }
      catch (cause) { if (cause?.code === 'E_NOT_IMPLEMENTED') warnings.push(`${moduleManifest.name} installed inactive.`); else throw cause; }
    }
    output({ action: 'module add', modules: installNames, warnings });
  } catch (cause) {
    for (const directory of installedDirs.reverse()) await rm(directory, { recursive: true, force: true });
    if (!cfg.modules.includes('*')) await saveTrackedConfig(cfg, paths, env).catch(() => {});
    throw cause;
  }
}

export function enableOffline(env = process.env) {
  if (env.BRAINATLAS_OFFLINE === '1') globalThis.fetch = async () => { throw error('E_OFFLINE', 'Network access is disabled.'); };
}
export async function main(argv = process.argv.slice(2), env = process.env, dependencies = {}) {
  const args = [...argv]; const command = args.shift();
  const flag = name => args.includes(name);
  const value = name => { const i = args.indexOf(name); if (i < 0) return undefined; if (!args[i + 1] || args[i + 1].startsWith('--')) throw error('E_ARGUMENT', `Missing value for ${name}.`); return args[i + 1]; };
  const paths = resolvePaths({ platform: env.BRAINATLAS_PLATFORM || process.platform, env });
  const json = flag('--json'); const plan = flag('--plan');
  let redactCommandOutput = plan || (json && (command === 'status' || command === 'doctor'));
  const output = data => {
    const hideHome = plan && ['init', 'config', 'module', 'uninstall', 'update', 'rollback', 'recover'].includes(command);
    const result = redactCommandOutput ? redactOutput(data, hideHome ? env.HOME : undefined) : data;
    console.log(json || plan ? JSON.stringify(result, null, 2) : typeof result === 'string' ? result : JSON.stringify(result, null, 2));
  };
  const config = () => loadConfig({ paths, env });
  if (command === '--help' || command === '-h' || command === 'help') {
    const topic = command === 'help' ? args.find(argument => !argument.startsWith('--')) : undefined;
    await showHelp(topic, { paths, env, output, json }); return;
  }
  if (command === 'migrate') {
    const from = value('--from'); const to = value('--to');
    if (!from || !to) throw error('E_ARGUMENT', 'migrate requires --from <old-vault> and --to <new-vault>.');
    output(await migrateVault(from, to, { plan })); return;
  }
  if (command === 'adopt') {
    if (!plan) throw error('E_ARGUMENT', 'adopt requires --plan.');
    output(await adoptPlan(env.HOME)); return;
  }
  if (command === 'init') {
    let vault = value('--vault');
    if (!vault && !flag('--yes')) {
      if (!process.stdin.isTTY) throw error('E_ARGUMENT', 'Use --vault or --yes for non-interactive initialization.');
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try { vault = await rl.question('Vault path: '); } finally { rl.close(); }
    }
    const cfg = defaultConfig(value('--profile') || 'lite');
    cfg.vault.path = resolve(vault || join(env.HOME, 'BrainAtlas'));
    cfg.node.path = process.execPath;
    const agents = value('--agents'); cfg.agents = agents ? agents.split(',').map(item => item.trim()).filter(Boolean) : [];
    const adapterRoot = fileURLToPath(new URL('../../adapters/', import.meta.url));
    let available = []; try { available = await readdir(adapterRoot); } catch {}
    if (cfg.agents.some(a => !/^[a-z0-9-]+$/.test(a))) throw error('E_AGENT_UNKNOWN', 'Invalid agent adapter name.');
    const warnings = []; const plannedAdapters = [];
    for (const agent of cfg.agents) {
      if (!available.includes(agent)) { warnings.push(`Adapter ${agent} is unavailable.`); continue; }
      try {
        const adapter = await import(pathToFileURL(join(adapterRoot, agent, 'src/index.mjs')).href);
        const ctx = { env, config: cfg, paths, scope: cfg.scope, nodePath: process.execPath, shimPath: paths.binPath, now: new Date() };
        if (typeof adapter.plan !== 'function') { warnings.push(`Adapter ${agent} has no planner.`); continue; }
        const changes = await adapter.plan(ctx); plannedAdapters.push({ agent, changes });
        if (!plan && typeof adapter.apply === 'function') {
          const before = new Map(); const beforeNames = new Map(); const createdDirectories = [];
          for (const change of changes?.changes || []) {
            const target = resolve(change.file);
            before.set(change.file, await snapshotPath(target));
            const parent = dirname(target); createdDirectories.push(...await missingDirectories(parent, env.HOME, managedRoots(paths, env)));
            if (!beforeNames.has(parent)) beforeNames.set(parent, new Set(await readdir(parent).catch(cause => { if (cause.code === 'ENOENT') return []; throw cause; })));
          }
          if (changes?.trustReviewRequired && typeof adapter.trustReview === 'function') await adapter.trustReview(ctx);
          await adapter.apply(changes, ctx);
          for (const change of changes?.changes || []) {
            const file = resolve(change.file);
            await recordManagedWrite(paths, file, { before: before.get(change.file), after: await snapshotPath(file), owner: agent, role: 'adapter-config' });
          }
          for (const change of changes?.changes || []) {
            const target = resolve(change.file); const parent = dirname(target); const known = beforeNames.get(parent) || new Set();
            for (const file of await readdir(parent).catch(() => [])) {
              if (file.startsWith(`${basename(target)}.bak.`) && !known.has(file)) {
                const backup = join(parent, file); await recordManagedWrite(paths, backup, { before: null, after: await snapshotPath(backup), owner: agent, role: 'adapter-backup' });
              }
            }
          }
          if (createdDirectories.length) await recordCreatedDirectories(paths, createdDirectories, env.HOME, managedRoots(paths, env));
        } else if (!plan) warnings.push(`Adapter ${agent} has no apply operation.`);
      } catch (e) { if (e.code === 'E_NOT_IMPLEMENTED' || e.code === 'ERR_MODULE_NOT_FOUND') warnings.push(`Adapter ${agent} is unavailable.`); else throw e; }
    }
    if (!plan) await saveTrackedConfig(cfg, paths, env);
    output({ action: 'init', configFile: paths.configFile, warnings, adapters: plan ? plannedAdapters.map(item => redactOutput(item.changes, env.HOME)) : undefined }); return;
  }
  if (command === 'install' && flag('--finalize')) {
    const createdDirectories = [];
    for (let index = 0; index < args.length; index++) if (args[index] === '--created-dir' && args[index + 1] && !args[index + 1].startsWith('--')) createdDirectories.push(args[index + 1]);
    if (plan) { output({ action: 'install', files: [paths.binPath, join(env.HOME, '.local', 'bin', 'brainatlas'), join(env.HOME, '.local', 'bin', 'ba')], createdDirectories }); return; }
    if (!(await readCurrent(paths))) throw error('E_RELEASE_MISSING', 'No release is installed.');
    await writeInstallEntrypoints(paths, env);
    if (createdDirectories.length) await recordCreatedDirectories(paths, createdDirectories, env.HOME, managedRoots(paths, env));
    output({ action: 'install', current: await readCurrent(paths) }); return;
  }
  if (command === 'status' || command === 'doctor') {
    const result = await doctorResult(paths, env);
    const current = await readCurrent(paths);
    output({ ...result, currentVersion: current?.slice('releases/'.length) ?? null });
    if (command === 'doctor' && !result.ok) process.exitCode = 1;
    return;
  }
  if (command === 'config') {
    const action = args.shift(); const key = args.shift(); const cfg = await config();
    if (action === 'get') {
      if (key && !key.startsWith('--') && !/^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*$/.test(key)) throw error('E_CONFIG_KEY', 'Invalid configuration key.');
      const result = key && !key.startsWith('--') ? key.split('.').reduce((v, k) => v?.[k], cfg) : cfg;
      if (result === undefined) throw error('E_CONFIG_KEY', 'Unknown configuration key.');
      redactCommandOutput = true; output(result); return;
    }
    if (action === 'set') {
      if (!key || !/^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*$/.test(key)) throw error('E_CONFIG_KEY', 'Invalid configuration key.');
      const raw = args.shift(); if (raw === undefined || raw.startsWith('--')) throw error('E_ARGUMENT', 'Missing configuration value.');
      let parsed; try { parsed = JSON.parse(raw); } catch { parsed = raw; }
      const updated = setCliConfigValue(cfg, key, parsed); if (!plan) await saveTrackedConfig(updated, paths, env);
      let credentialUrl = false;
      if (key === 'sync.options.remote' && typeof parsed === 'string' && /^https:\/\//i.test(parsed)) {
        try { const remote = new URL(parsed); credentialUrl = Boolean(remote.username || remote.password); } catch {}
      }
      const warnings = credentialUrl ? ['Remote URL contains embedded credentials; use a credential helper instead.'] : [];
      if (warnings.length) console.error(warnings[0]);
      output({ action: 'config set', key, ...(warnings.length ? { warnings } : {}) }); return;
    }
    throw error('E_ARGUMENT', 'Configuration action is invalid.');
  }
  if (command === 'module') { await moduleCommand(args, { paths, env, output, plan, value }); return; }
  if (command === 'uninstall') {
    const manifest = await readInstallManifest(paths); const cfg = await loadConfig({ paths, env }).catch(() => defaultConfig('lite'));
    const roots = managedRoots(paths, env);
    if (plan) { output({ ...(await uninstallManagedFiles(paths, { plan: true })), appDirectory: paths.dataDir, keepVault: true, adapters: cfg.agents || [] }); return; }
    const adapterWarnings = await removeAdapters(cfg, paths, env);
    const activeManifest = await readInstallManifest(paths);
    const configFile = await resolveManagedPath(paths.configFile);
    const priorConfig = activeManifest.files.find(item => item.path === configFile && item.beforeSha256 && item.backupPath);
    let priorVault = null;
    if (priorConfig) try { priorVault = JSON.parse(await readFile(priorConfig.backupPath, 'utf8'))?.vault?.path; } catch {}
    const restored = await uninstallManagedFiles(paths, { home: env.HOME, roots });
    const dataDir = await resolveManagedPath(paths.dataDir, { followFinal: true });
    const preserved = activeManifest.files.filter(item => item.beforeSha256 && item.path.startsWith(`${dataDir}${sep}`)).map(item => item.path);
    if (cfg.vault.path) preserved.push(resolve(cfg.vault.path));
    if (priorVault && typeof priorVault === 'string' && priorVault.startsWith('/')) preserved.push(priorVault);
    await removeAppDataPreserving(paths, preserved);
    await rm(paths.stateDir, { recursive: true, force: true });
    await removeCreatedDirectories(restored.createdDirectories, env.HOME, roots);
    output({ action: 'uninstall', restored: restored.restored, vaultPreserved: true, warnings: adapterWarnings }); return;
  }
  if (command === 'update' && (flag('--check') || flag('--metadata-only'))) {
    const archivePath = value('--from');
    if (archivePath) {
      const { manifest } = await inspectReleaseArchive(resolve(archivePath), releaseSigner(paths, env));
      const current = await readCurrent(paths); const currentVersion = current?.slice('releases/'.length) ?? null;
      const order = currentVersion === null ? 1 : compareVersions(manifest.version, currentVersion);
      output({ status: order > 0 ? 'available' : order === 0 ? 'up-to-date' : 'current-newer', currentVersion, offeredVersion: manifest.version, profile: manifest.profile }); return;
    }
    if (env.BRAINATLAS_OFFLINE === '1') { output({ status: 'unknown', reason: 'offline' }); return; }
    const metadataUrl = env.BRAINATLAS_UPDATE_METADATA_URL;
    if (!metadataUrl) { output({ status: 'unknown', reason: 'metadata-unavailable' }); return; }
    try {
      const fetchImpl = dependencies.fetch ?? globalThis.fetch;
      const response = await fetchImpl(metadataUrl, { headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error();
      const metadata = await response.json();
      if (!validVersion(metadata?.version)) throw new Error();
      const current = await readCurrent(paths); const currentVersion = current?.slice('releases/'.length) ?? null;
      const order = currentVersion === null ? 1 : compareVersions(metadata.version, currentVersion);
      output({ status: order > 0 ? 'available' : order === 0 ? 'up-to-date' : 'current-newer', currentVersion, offeredVersion: metadata.version });
    } catch (cause) { output({ status: 'unknown', reason: cause?.code === 'E_OFFLINE' ? 'offline' : 'metadata-unavailable' }); }
    return;
  }
  if (command === 'update' && flag('--from')) {
    const archive = resolve(value('--from'));
    const signer = releaseSigner(paths, env);
    const { manifest } = await inspectReleaseArchive(archive, signer);
    const target = releaseLink(manifest.version);
    const previous = await readCurrent(paths);
    if (await exists(join(paths.releasesDir, manifest.version))) throw error('E_RELEASE_EXISTS', 'Release version is already installed.');
    const staging = `releases/.staging-${process.pid}-${Date.now()}`;
    if (plan) { output({ action: 'update', version: manifest.version, profile: manifest.profile, from: archive, previous, target }); return; }
    const state = { schemaVersion: 1, kind: 'update', phase: 'extracting', version: manifest.version, target, previous, staging };
    await mkdir(paths.releasesDir, { recursive: true });
    await writeJsonFile(journalPath(paths), state, paths, env);
    try {
      const extracted = await extractVerifiedRelease(archive, join(paths.dataDir, staging), signer);
      if (extracted.version !== manifest.version) throw error('E_MANIFEST_INVALID', 'Release version changed during extraction.');
      await rename(join(paths.dataDir, staging), join(paths.releasesDir, manifest.version));
      state.phase = 'prepared'; await writeJsonFile(journalPath(paths), state, paths, env);
      state.phase = 'switching'; await writeJsonFile(journalPath(paths), state, paths, env);
      await switchCurrent(paths, target);
      state.phase = 'switched'; await writeJsonFile(journalPath(paths), state, paths, env);
      const health = checkCurrentRelease(paths, env);
      if (!health.ok) {
        await switchCurrent(paths, previous);
        state.phase = 'rolled-back'; await writeJsonFile(journalPath(paths), state, paths, env);
        await clearJournal(paths);
        throw error('E_DOCTOR_FAILED', 'New release failed its health check; previous release restored.');
      }
      await savePrevious(paths, previous, env);
      state.phase = 'complete'; await writeJsonFile(journalPath(paths), state, paths, env);
      await clearJournal(paths);
      output({ action: 'update', version: manifest.version, profile: manifest.profile, doctor: health }); return;
    } catch (cause) {
      const currentJournal = await readJournal(paths).catch(() => null);
      if (currentJournal?.phase === 'extracting' || currentJournal?.phase === 'prepared') {
        await rm(join(paths.dataDir, staging), { recursive: true, force: true });
        await clearJournal(paths);
      } else if (currentJournal?.phase === 'switching') {
        await switchCurrent(paths, previous); await clearJournal(paths);
      }
      throw cause;
    }
  }
  if (command === 'rollback') {
    const current = await readCurrent(paths); const requested = value('--to');
    const target = requested ? releaseLink(requested) : await readPrevious(paths);
    if (requested && !validVersion(requested)) throw error('E_ARGUMENT', 'Release version is invalid.');
    if (!target || target === current) throw error('E_RELEASE_MISSING', 'No different previous release is available.');
    if (!(await exists(join(paths.dataDir, target)))) throw error('E_RELEASE_MISSING', 'Requested release is unavailable.');
    if (plan) { output({ action: 'rollback', from: current, to: target }); return; }
    const state = { schemaVersion: 1, kind: 'rollback', phase: 'switching', version: target.slice('releases/'.length), target, previous: current, staging: null };
    await writeJsonFile(journalPath(paths), state, paths, env);
    await switchCurrent(paths, target);
    state.phase = 'switched'; await writeJsonFile(journalPath(paths), state, paths, env);
    await savePrevious(paths, current, env);
    state.phase = 'complete'; await writeJsonFile(journalPath(paths), state, paths, env);
    await clearJournal(paths);
    output({ action: 'rollback', from: current, to: target }); return;
  }
  if (command === 'recover') {
    if (plan) { const journal = await readJournal(paths); output({ action: 'recover', pending: Boolean(journal), journal }); return; }
    output(await recoverUpdate(paths, env)); return;
  }
  if (command === 'eval') {
    let component;
    try { component = await import(new URL('../../../eval/run-eval.mjs', import.meta.url)); }
    catch (e) { if (e.code === 'ERR_MODULE_NOT_FOUND') throw error('E_COMPONENT_MISSING', 'Evaluation component is unavailable.'); throw e; }
    if (typeof component.runEval !== 'function') throw error('E_COMPONENT_MISSING', 'Evaluation component is unavailable.');
    const evalDir = new URL('../../../eval/', import.meta.url);
    try { output(component.runEval({ casesFile: value('--cases') || fileURLToPath(new URL('dev/cases.json', evalDir)), corpusDir: value('--corpus') || fileURLToPath(new URL('corpus/', evalDir)) })); }
    catch { throw error('E_EVAL_FAILED', 'Evaluation could not complete.'); }
    return;
  }
  if (command === 'hook' || command === 'mcp') {
    let component;
    try { component = command === 'hook' ? await import('@brainatlas/hooks') : await import('@brainatlas/mcp'); }
    catch (e) { if (e.code === 'ERR_MODULE_NOT_FOUND') throw error('E_COMPONENT_MISSING', 'Requested component is unavailable.'); throw e; }
    const entry = command === 'hook' ? component.runHook : component.main;
    if (typeof entry !== 'function') throw error('E_COMPONENT_MISSING', 'Requested component entry point is unavailable.');
    try {
      if (command === 'mcp') await entry();
      else {
        const client = args[0]; const event = args[1];
        if (args.length !== 2 || !['claude', 'codex', 'kiro', 'copilot', 'gemini'].includes(client) || !['prompt', 'session-start', 'session-end'].includes(event)) throw error('E_ARGUMENT', 'Hook client and event are required.');
        let stdin = ''; for await (const chunk of process.stdin) { stdin += chunk; if (stdin.length > 1024 * 1024) throw error('E_HOOK_INPUT', 'Hook input is too large.'); }
        const cfg = await config(); cfg.stateDir = join(paths.stateDir, vaultId(cfg.vault.path));
        const roots = managedRoots(paths, env); const created = await missingDirectories(cfg.stateDir, env.HOME, roots); await mkdir(cfg.stateDir, { recursive: true });
        if (created.length) await recordCreatedDirectories(paths, created, env.HOME, roots);
        let result;
        if (event === 'session-end') {
          let hookInput = {};
          try {
            const parsed = stdin.trim() ? JSON.parse(stdin) : {};
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) hookInput = parsed;
          } catch { /* The hook component handles malformed payloads fail-open. */ }
          const queued = await queueSessionEndReceipt({ client, hookInput, config: cfg, paths, env });
          result = queued ? await entry({ client, event, stdin, env, now: new Date(), config: cfg }) : { stdout: '', exitCode: 0 };
        } else result = await entry({ client, event, stdin, env, now: new Date(), config: cfg });
        if (result.stdout) process.stdout.write(result.stdout); process.exitCode = result.exitCode;
      }
    } catch (e) { if (e.code === 'E_NOT_IMPLEMENTED') throw error('E_COMPONENT_MISSING', 'Requested component is unavailable.'); throw e; }
    return;
  }
  if (command && !builtInCommands.has(command)) { await dispatchModuleCommand(command, args, { paths, env, output }); return; }
  throw error(command ? 'E_ARGUMENT' : 'E_COMMAND_UNKNOWN', command ? 'Command arguments are invalid.' : 'Unknown command.');
}
export const activate = main;
