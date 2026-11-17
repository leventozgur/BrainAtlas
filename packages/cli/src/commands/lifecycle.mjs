// SPDX-License-Identifier: MIT
import { access, chmod, lstat, mkdir, readdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { defaultConfig, loadConfig, validateConfig } from '@brainatlas/core';
import { inspectReleaseArchive, extractVerifiedRelease } from '../archive.mjs';
import {
  managePath,
  recordManagedWrite,
  recordCreatedDirectories,
  missingDirectories,
  readInstallManifest,
  resolveManagedPath,
  snapshotPath,
  uninstallManagedFiles,
  removeCreatedDirectories,
} from '../install-manifest.mjs';
import { installedSyncSchedule } from './sync.mjs';
import {
  error,
  validVersion,
  managedRoots,
  exists,
  readCurrent,
  validateReleaseLink,
  releaseSigner,
  currentReleaseDir,
  enabledModuleEntries,
  moduleContext,
  activateEnabledModules,
} from './shared.mjs';

function compareVersions(left, right) {
  const parse = (value) => /^(?:v)?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value);
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return left === right ? 0 : left < right ? -1 : 1;
  const aCore = a[1].split('.').map(Number);
  const bCore = b[1].split('.').map(Number);
  for (let index = 0; index < Math.max(aCore.length, bCore.length); index++) {
    const difference = (aCore[index] || 0) - (bCore[index] || 0);
    if (difference) return Math.sign(difference);
  }
  if (a[2] === undefined || b[2] === undefined) return a[2] === b[2] ? 0 : a[2] === undefined ? 1 : -1;
  const aPre = a[2].split('.');
  const bPre = b[2].split('.');
  for (let index = 0; index < Math.max(aPre.length, bPre.length); index++) {
    if (aPre[index] === undefined || bPre[index] === undefined)
      return aPre[index] === bPre[index] ? 0 : aPre[index] === undefined ? -1 : 1;
    const an = /^\d+$/.test(aPre[index]);
    const bn = /^\d+$/.test(bPre[index]);
    if (an && bn && Number(aPre[index]) !== Number(bPre[index]))
      return Number(aPre[index]) < Number(bPre[index]) ? -1 : 1;
    if (an !== bn) return an ? -1 : 1;
    if (aPre[index] !== bPre[index]) return aPre[index] < bPre[index] ? -1 : 1;
  }
  return 0;
}
const journalPath = (paths) => join(paths.stateDir, 'update-journal.json');
const previousPath = (paths) => join(paths.stateDir, 'previous-release');
const releaseLink = (version) => `releases/${version}`;

async function writeJsonFile(file, value, paths = null, env = process.env) {
  const roots = paths ? managedRoots(paths, env) : [env.HOME];
  const created = paths ? await missingDirectories(dirname(file), env.HOME, roots) : [];
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}`;
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'w', mode: 0o600 });
    await rename(temp, file);
  } catch {
    await rm(temp, { force: true });
    throw error('E_STATE_WRITE', 'Could not write update state.');
  }
  if (paths && created.length) await recordCreatedDirectories(paths, created, env.HOME, roots);
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
    try {
      releaseStat = await lstat(join(paths.dataDir, target));
    } catch {
      throw error('E_RELEASE_MISSING', 'Requested release is unavailable.');
    }
    if (!releaseStat.isDirectory() || releaseStat.isSymbolicLink())
      throw error('E_RELEASE_INVALID', 'Requested release is invalid.');
  }
  await mkdir(paths.dataDir, { recursive: true });
  const temp = `${paths.currentDir}.next-${process.pid}`;
  await rm(temp, { force: true });
  try {
    if (target === null) await rm(paths.currentDir, { force: true });
    else {
      await symlink(target, temp);
      await rename(temp, paths.currentDir);
    }
  } catch {
    await rm(temp, { force: true });
    throw error('E_CURRENT_SWITCH', 'Could not switch the current release.');
  }
  const after = await snapshotPath(paths.currentDir);
  await recordManagedWrite(paths, paths.currentDir, { before, after });
}
async function savePrevious(paths, target, env = process.env) {
  if (target === null) {
    await rm(previousPath(paths), { force: true });
    return;
  }
  validateReleaseLink(target, false);
  const roots = managedRoots(paths, env);
  const created = await missingDirectories(paths.stateDir, env.HOME, roots);
  await mkdir(paths.stateDir, { recursive: true });
  await writeFile(previousPath(paths), `${target}\n`, { mode: 0o600 });
  if (created.length) await recordCreatedDirectories(paths, created, env.HOME, roots);
}
async function readPrevious(paths) {
  try {
    return validateReleaseLink((await readFile(previousPath(paths), 'utf8')).trim(), false);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    if (e.code === 'E_JOURNAL_INVALID') throw e;
    throw error('E_STATE_READ', 'Could not read release state.');
  }
}
async function readJournal(paths) {
  try {
    const value = JSON.parse(await readFile(journalPath(paths), 'utf8'));
    if (
      value?.schemaVersion !== 1 ||
      !['update', 'rollback'].includes(value.kind) ||
      !['extracting', 'prepared', 'switching', 'switched', 'complete', 'rolled-back'].includes(value.phase)
    )
      throw new Error();
    validateReleaseLink(value.target, false);
    validateReleaseLink(value.previous, true);
    if (
      value.staging !== null &&
      (typeof value.staging !== 'string' || !/^releases\/\.staging-[A-Za-z0-9._-]+$/.test(value.staging))
    )
      throw new Error();
    return value;
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw error('E_JOURNAL_INVALID', 'Update journal is invalid.');
  }
}
async function clearJournal(paths) {
  await rm(journalPath(paths), { force: true });
}
async function doctorResult(paths, env) {
  let cfg;
  let configOk;
  try {
    cfg = await loadConfig({ paths, env });
    configOk = validateConfig(cfg).ok;
  } catch {
    cfg = defaultConfig('lite');
    configOk = false;
  }
  const checks = { config: configOk };
  try {
    await access(paths.currentDir);
    checks.release = true;
  } catch {
    checks.release = false;
  }
  const warnings = [];
  const moduleHealth = [];
  if (checks.release && cfg.agents?.length) {
    const adapterRoot = fileURLToPath(new URL('../../../adapters/', import.meta.url));
    for (const agent of cfg.agents) {
      try {
        const adapter = await import(pathToFileURL(join(adapterRoot, agent, 'src/index.mjs')).href);
        if (typeof adapter.doctor === 'function')
          checks[`adapter:${agent}`] = Boolean(
            (
              await adapter.doctor({
                env,
                config: cfg,
                paths,
                scope: cfg.scope,
                nodePath: cfg.node.path,
                shimPath: paths.binPath,
                now: new Date(),
              })
            )?.ok
          );
        else warnings.push(`Adapter ${agent} has no health check.`);
      } catch (cause) {
        if (cause?.code === 'ERR_MODULE_NOT_FOUND' || cause?.code === 'E_NOT_IMPLEMENTED')
          warnings.push(`Adapter ${agent} is unavailable.`);
        else checks[`adapter:${agent}`] = false;
      }
    }
  }
  if (checks.release && cfg.modules?.length) {
    try {
      const current = await readCurrent(paths);
      const releaseDir = currentReleaseDir(paths, current);
      if (releaseDir) {
        const { ordered, entries } = await enabledModuleEntries(releaseDir, cfg);
        const ctx = moduleContext(cfg, paths, env, entries, ordered);
        await activateEnabledModules(ordered, entries, ctx);
        const syncModule = ordered.find((item) => (item.provides || []).includes('sync'));
        if (syncModule) {
          let sync = null;
          try {
            sync = await entries.get(syncModule.name)?.commands?.status?.(ctx);
          } catch {
            warnings.push('Sync health is unavailable.');
          }
          let lastSync = null;
          try {
            const manifest = JSON.parse(
              await readFile(join(paths.stateDir, 'sync', 'last-synced-manifest.json'), 'utf8')
            );
            if (typeof manifest.generatedAt === 'string') lastSync = manifest.generatedAt;
          } catch {
            /* No successful sync has been recorded. */
          }
          moduleHealth.push({
            name: 'sync',
            transport: cfg.sync?.transport ?? null,
            status: sync?.status ?? 'unknown',
            lastSync,
          });
        }
        if (ordered.some((item) => item.name === 'semantic')) {
          let freshness = null;
          if (cfg.semantic?.enabled === true)
            try {
              const semantic = entries.get('semantic');
              const index = await semantic?.readSemanticIndex?.(paths.stateDir);
              freshness = index ? await semantic.measureIndexFreshness({ corpusDir: cfg.vault.path, index }) : null;
              if (!index) warnings.push('Semantic index is not available.');
            } catch {
              warnings.push('Semantic index freshness is unavailable.');
            }
          moduleHealth.push({ name: 'semantic', enabled: cfg.semantic?.enabled === true, freshness });
        }
      }
    } catch {
      warnings.push('Module health summary is unavailable.');
    }
  }
  if (env.BRAINATLAS_TEST_DOCTOR_FAIL === '1') checks.injected = false;
  return {
    ok: Object.values(checks).every(Boolean),
    checks,
    profile: cfg.profile,
    modules: cfg.modules,
    moduleHealth,
    warnings,
  };
}
async function removeAdapters(cfg, paths, env) {
  const adapterRoot = fileURLToPath(new URL('../../../adapters/', import.meta.url));
  const warnings = [];
  for (const agent of cfg.agents || []) {
    try {
      const adapter = await import(pathToFileURL(join(adapterRoot, agent, 'src/index.mjs')).href);
      if (typeof adapter.remove !== 'function') {
        warnings.push(`Adapter ${agent} has no remove operation.`);
        continue;
      }
      const ctx = {
        env,
        config: cfg,
        paths,
        scope: cfg.scope,
        nodePath: cfg.node.path,
        shimPath: paths.binPath,
        now: new Date(),
      };
      // An init-time conflict (for example a pre-existing skill file) must not stop uninstall:
      // removal reaches the adapter so it can report E_MANAGED_BLOCK_EDITED or restore user bytes.
      // A user's MCP entry or hook must not block removing the cli-channel files either.
      const planForRemoval = async () => {
        if (typeof adapter.plan !== 'function') return { changes: [] };
        try {
          return await adapter.plan(ctx);
        } catch (cause) {
          if (cfg.channel === 'cli' && (cause?.reason === 'skill-file' || cause?.code === 'E_CHANNEL_SWITCH'))
            return { changes: [] };
          throw cause;
        }
      };
      const planned = await planForRemoval();
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
        if (!knownNames.has(parent))
          knownNames.set(
            parent,
            new Set(
              await readdir(parent).catch((cause) => {
                if (cause.code === 'ENOENT') return [];
                throw cause;
              })
            )
          );
      }
      await adapter.remove(ctx);
      for (const [file, before] of managed) {
        const after = await snapshotPath(file);
        if (before?.sha256 !== after?.sha256 || before?.kind !== after?.kind || before?.mode !== after?.mode) {
          await recordManagedWrite(paths, file, { before, after, owner: agent });
        }
        const parent = dirname(file);
        const known = knownNames.get(parent) || new Set();
        for (const name of await readdir(parent).catch((cause) => {
          if (cause.code === 'ENOENT') return [];
          throw cause;
        })) {
          if (!name.startsWith(`${basename(file)}.bak.`) || known.has(name)) continue;
          const backup = join(parent, name);
          await recordManagedWrite(paths, backup, {
            before: null,
            after: await snapshotPath(backup),
            owner: agent,
            role: 'adapter-backup',
          });
        }
      }
    } catch (cause) {
      if (cause?.code === 'E_NOT_IMPLEMENTED' || cause?.code === 'ERR_MODULE_NOT_FOUND')
        warnings.push(`Adapter ${agent} is unavailable.`);
      else throw cause;
    }
  }
  return warnings;
}
function checkCurrentRelease(paths, env) {
  const cli = join(paths.currentDir, 'packages', 'cli', 'bin', 'brainatlas.mjs');
  const result = spawnSync(process.execPath, [cli, 'doctor', '--json'], { env, encoding: 'utf8', timeout: 15000 });
  let report;
  try {
    report = JSON.parse(result.stdout || '');
  } catch {
    report = null;
  }
  if (!report || typeof report.ok !== 'boolean') return { ok: false, checks: { doctor: false } };
  if (result.error || result.status !== 0) report.ok = false;
  return report;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

async function writeInstallEntrypoints(paths, env) {
  const shim = paths.binPath;
  const localBin = join(env.HOME, '.local', 'bin');
  const roots = managedRoots(paths, env);
  const created = [
    ...(await missingDirectories(dirname(shim), env.HOME, roots)),
    ...(await missingDirectories(localBin, env.HOME, roots)),
  ];
  const cli = join(paths.currentDir, 'packages', 'cli', 'bin', 'brainatlas.mjs');
  const shimContent = `#!/bin/sh\n":" //; exec ${shellQuote(process.execPath)} "$0" "$@"\nimport('node:url').then(({ pathToFileURL }) => import(pathToFileURL(${JSON.stringify(cli)}).href)).catch(error => { console.error(error); process.exitCode = 1; });\n`;
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
    await managePath(paths, link, async () => {
      await rm(link, { force: true });
      await symlink(shim, link);
    });
  }
  if (created.length) await recordCreatedDirectories(paths, created, env.HOME, roots);
}

async function removeAppDataPreserving(paths, keepFiles = [], vaultPath = null) {
  const dataDir = await resolveManagedPath(paths.dataDir, { followFinal: true });
  const keep = new Set(
    await Promise.all(keepFiles.map((path) => resolveManagedPath(resolve(path), { followFinal: true })))
  );
  if (vaultPath) keep.add(await resolveManagedPath(resolve(vaultPath), { followFinal: true }));
  try {
    const stat = await lstat(paths.dataDir);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw error('E_UNINSTALL_CONFLICT', `Application data directory is unsafe: ${paths.dataDir}.`, {
        path: paths.dataDir,
        conflicts: [paths.dataDir],
      });
  } catch (cause) {
    if (cause?.code === 'ENOENT') return;
    throw cause;
  }
  async function removeTree(dir) {
    const entries = await readdir(dir, { withFileTypes: true }).catch((cause) => {
      if (cause.code === 'ENOENT') return null;
      throw cause;
    });
    if (!entries) return false;
    let retained = false;
    for (const entry of entries) {
      const file = join(dir, entry.name);
      const preservesSubtree = [...keep].some((path) => path === file || path.startsWith(`${file}${sep}`));
      const insidePreservedPath = [...keep].some((path) => file === path || file.startsWith(`${path}${sep}`));
      if (insidePreservedPath) {
        retained = true;
        continue;
      }
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

async function recoverUpdate(paths, env) {
  const journal = await readJournal(paths);
  if (!journal) return { recovered: false };
  const target = validateReleaseLink(journal.target, false);
  const previous = validateReleaseLink(journal.previous, true);
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
    return {
      recovered: true,
      action:
        journal.kind === 'rollback' && journal.phase === 'switching'
          ? 'completed-rollback'
          : 'restored-previous-release',
    };
  }
  if (journal.phase === 'switched') {
    if (journal.kind === 'rollback') {
      await switchCurrent(paths, target);
      await savePrevious(paths, previous, env);
      await clearJournal(paths);
      return { recovered: true, action: 'completed-rollback' };
    }
    await switchCurrent(paths, target);
    const health = checkCurrentRelease(paths, env);
    if (!health.ok) {
      await switchCurrent(paths, previous);
      await clearJournal(paths);
      return { recovered: true, action: 'rolled-back-after-doctor', doctor: health };
    }
    await savePrevious(paths, previous, env);
    await clearJournal(paths);
    return { recovered: true, action: 'completed-update', doctor: health };
  }
  await switchCurrent(paths, target);
  await savePrevious(paths, previous, env);
  await clearJournal(paths);
  return { recovered: true, action: 'completed-update' };
}

export async function install({ args, flag, plan, output, paths, env }) {
  if (flag('--finalize')) {
    const createdDirectories = [];
    for (let index = 0; index < args.length; index++)
      if (args[index] === '--created-dir' && args[index + 1] && !args[index + 1].startsWith('--'))
        createdDirectories.push(args[index + 1]);
    if (plan) {
      output({
        action: 'install',
        files: [paths.binPath, join(env.HOME, '.local', 'bin', 'brainatlas'), join(env.HOME, '.local', 'bin', 'ba')],
        createdDirectories,
      });
      return;
    }
    if (!(await readCurrent(paths))) throw error('E_RELEASE_MISSING', 'No release is installed.');
    await writeInstallEntrypoints(paths, env);
    if (createdDirectories.length)
      await recordCreatedDirectories(paths, createdDirectories, env.HOME, managedRoots(paths, env));
    output({ action: 'install', current: await readCurrent(paths) });
    return;
  }
  throw error('E_ARGUMENT', 'Command arguments are invalid.');
}

export async function status({ command, output, paths, env }) {
  const result = await doctorResult(paths, env);
  const current = await readCurrent(paths);
  output({ ...result, currentVersion: current?.slice('releases/'.length) ?? null });
  if (command === 'doctor' && !result.ok) process.exitCode = 1;
  return;
}

export async function uninstall({ plan, output, paths, env, dependencies }) {
  await readInstallManifest(paths);
  const cfg = await loadConfig({ paths, env }).catch(() => defaultConfig('lite'));
  const roots = managedRoots(paths, env);
  if (plan) {
    const scheduler = await installedSyncSchedule('remove', {
      paths,
      env,
      config: cfg,
      dependencies: { ...dependencies, plan: true },
    });
    output({
      ...(await uninstallManagedFiles(paths, { plan: true })),
      appDirectory: paths.dataDir,
      keepVault: true,
      adapters: cfg.agents || [],
      scheduler,
    });
    return;
  }
  const scheduler = await installedSyncSchedule('remove', { paths, env, config: cfg, dependencies });
  const adapterWarnings = await removeAdapters(cfg, paths, env);
  const activeManifest = await readInstallManifest(paths);
  const configFile = await resolveManagedPath(paths.configFile);
  const priorConfig = activeManifest.files.find(
    (item) => item.path === configFile && item.beforeSha256 && item.backupPath
  );
  let priorVault = null;
  if (priorConfig)
    try {
      priorVault = JSON.parse(await readFile(priorConfig.backupPath, 'utf8'))?.vault?.path;
    } catch {
      /* a missing or unreadable backup means there is no prior vault path */
    }
  const restored = await uninstallManagedFiles(paths, { home: env.HOME, roots });
  const dataDir = await resolveManagedPath(paths.dataDir, { followFinal: true });
  const preserved = activeManifest.files
    .filter((item) => item.beforeSha256 && item.path.startsWith(`${dataDir}${sep}`))
    .map((item) => item.path);
  if (cfg.vault.path) preserved.push(resolve(cfg.vault.path));
  if (priorVault && typeof priorVault === 'string' && priorVault.startsWith('/')) preserved.push(priorVault);
  await removeAppDataPreserving(paths, preserved);
  await rm(paths.stateDir, { recursive: true, force: true });
  await removeCreatedDirectories(restored.createdDirectories, env.HOME, roots);
  output({
    action: 'uninstall',
    restored: restored.restored,
    vaultPreserved: true,
    warnings: adapterWarnings,
    scheduler,
  });
  return;
}

export async function update({ args, flag, value, plan, output, paths, env, dependencies }) {
  if (flag('--check') || flag('--metadata-only')) {
    const archivePath = value('--from');
    if (archivePath) {
      const { manifest } = await inspectReleaseArchive(resolve(archivePath), releaseSigner(paths, env));
      const current = await readCurrent(paths);
      const currentVersion = current?.slice('releases/'.length) ?? null;
      const order = currentVersion === null ? 1 : compareVersions(manifest.version, currentVersion);
      output({
        status: order > 0 ? 'available' : order === 0 ? 'up-to-date' : 'current-newer',
        currentVersion,
        offeredVersion: manifest.version,
        profile: manifest.profile,
      });
      return;
    }
    if (env.BRAINATLAS_OFFLINE === '1') {
      output({ status: 'unknown', reason: 'offline' });
      return;
    }
    const metadataUrl = env.BRAINATLAS_UPDATE_METADATA_URL;
    if (!metadataUrl) {
      output({ status: 'unknown', reason: 'metadata-unavailable' });
      return;
    }
    try {
      const fetchImpl = dependencies.fetch ?? globalThis.fetch;
      const response = await fetchImpl(metadataUrl, { headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error();
      const metadata = await response.json();
      if (!validVersion(metadata?.version)) throw new Error();
      const current = await readCurrent(paths);
      const currentVersion = current?.slice('releases/'.length) ?? null;
      const order = currentVersion === null ? 1 : compareVersions(metadata.version, currentVersion);
      output({
        status: order > 0 ? 'available' : order === 0 ? 'up-to-date' : 'current-newer',
        currentVersion,
        offeredVersion: metadata.version,
      });
    } catch (cause) {
      output({ status: 'unknown', reason: cause?.code === 'E_OFFLINE' ? 'offline' : 'metadata-unavailable' });
    }
    return;
  }
  if (flag('--from')) {
    const archive = resolve(value('--from'));
    const signer = releaseSigner(paths, env);
    const { manifest } = await inspectReleaseArchive(archive, signer);
    const target = releaseLink(manifest.version);
    const previous = await readCurrent(paths);
    if (await exists(join(paths.releasesDir, manifest.version)))
      throw error('E_RELEASE_EXISTS', 'Release version is already installed.');
    const staging = `releases/.staging-${process.pid}-${Date.now()}`;
    if (plan) {
      output({
        action: 'update',
        version: manifest.version,
        profile: manifest.profile,
        from: archive,
        previous,
        target,
      });
      return;
    }
    const state = {
      schemaVersion: 1,
      kind: 'update',
      phase: 'extracting',
      version: manifest.version,
      target,
      previous,
      staging,
    };
    await mkdir(paths.releasesDir, { recursive: true });
    await writeJsonFile(journalPath(paths), state, paths, env);
    try {
      const extracted = await extractVerifiedRelease(archive, join(paths.dataDir, staging), signer);
      if (extracted.version !== manifest.version)
        throw error('E_MANIFEST_INVALID', 'Release version changed during extraction.');
      await rename(join(paths.dataDir, staging), join(paths.releasesDir, manifest.version));
      state.phase = 'prepared';
      await writeJsonFile(journalPath(paths), state, paths, env);
      state.phase = 'switching';
      await writeJsonFile(journalPath(paths), state, paths, env);
      await switchCurrent(paths, target);
      state.phase = 'switched';
      await writeJsonFile(journalPath(paths), state, paths, env);
      const health = checkCurrentRelease(paths, env);
      if (!health.ok) {
        await switchCurrent(paths, previous);
        state.phase = 'rolled-back';
        await writeJsonFile(journalPath(paths), state, paths, env);
        await clearJournal(paths);
        throw error('E_DOCTOR_FAILED', 'New release failed its health check; previous release restored.');
      }
      await savePrevious(paths, previous, env);
      state.phase = 'complete';
      await writeJsonFile(journalPath(paths), state, paths, env);
      await clearJournal(paths);
      output({ action: 'update', version: manifest.version, profile: manifest.profile, doctor: health });
      return;
    } catch (cause) {
      const currentJournal = await readJournal(paths).catch(() => null);
      if (currentJournal?.phase === 'extracting' || currentJournal?.phase === 'prepared') {
        await rm(join(paths.dataDir, staging), { recursive: true, force: true });
        await clearJournal(paths);
      } else if (currentJournal?.phase === 'switching') {
        await switchCurrent(paths, previous);
        await clearJournal(paths);
      }
      throw cause;
    }
  }
  throw error('E_ARGUMENT', 'Command arguments are invalid.');
}

export async function rollback({ value, plan, output, paths, env }) {
  const current = await readCurrent(paths);
  const requested = value('--to');
  const target = requested ? releaseLink(requested) : await readPrevious(paths);
  if (requested && !validVersion(requested)) throw error('E_ARGUMENT', 'Release version is invalid.');
  if (!target || target === current) throw error('E_RELEASE_MISSING', 'No different previous release is available.');
  if (!(await exists(join(paths.dataDir, target))))
    throw error('E_RELEASE_MISSING', 'Requested release is unavailable.');
  if (plan) {
    output({ action: 'rollback', from: current, to: target });
    return;
  }
  const state = {
    schemaVersion: 1,
    kind: 'rollback',
    phase: 'switching',
    version: target.slice('releases/'.length),
    target,
    previous: current,
    staging: null,
  };
  await writeJsonFile(journalPath(paths), state, paths, env);
  await switchCurrent(paths, target);
  state.phase = 'switched';
  await writeJsonFile(journalPath(paths), state, paths, env);
  await savePrevious(paths, current, env);
  state.phase = 'complete';
  await writeJsonFile(journalPath(paths), state, paths, env);
  await clearJournal(paths);
  output({ action: 'rollback', from: current, to: target });
  return;
}

export async function recover({ plan, output, paths, env }) {
  if (plan) {
    const journal = await readJournal(paths);
    output({ action: 'recover', pending: Boolean(journal), journal });
    return;
  }
  output(await recoverUpdate(paths, env));
  return;
}
