// SPDX-License-Identifier: MIT
import {
  access,
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  defaultConfig,
  effectiveChannel,
  lintPolicyReferences,
  loadConfig,
  refreshVaultPolicy,
  SECRET_FILTER_OFF_WARNING,
  secretFilterEnabled,
  validateConfig,
  vaultId,
} from '@brainatlas/core';
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
import { installedMaintainSchedule, installedSyncSchedule } from './sync.mjs';
import { buildHealthSummary, formatHealthSummary } from '../health.mjs';
import { readJsonl } from '../usage.mjs';
import { adapterHealth, removeAdapter } from './adapters.mjs';
import { commandNames } from '../index.mjs';
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
const UPDATE_RELEASES_URL = 'https://api.github.com/repos/leventozgur/BrainAtlas/releases?per_page=30';
const UPDATE_RELEASE_PREFIX = 'https://github.com/leventozgur/BrainAtlas/releases/';
const UPDATE_DOWNLOAD_PREFIX = 'https://github.com/leventozgur/BrainAtlas/releases/download/';
const UPDATE_ASSET_NAMES = Object.freeze({
  distribution: (version) => `brainatlas-${version}-distribution.tar.gz`,
  full: (version) => `brainatlas-${version}-full.tgz`,
  lite: (version) => `brainatlas-${version}-lite.tgz`,
  sha256sums: () => 'SHA256SUMS',
  signature: () => 'SHA256SUMS.sig',
});

/** @param {unknown} value @returns {value is Record<string, any>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @param {string} prefix
 * @returns {string|undefined}
 */
function prefixedUrl(value, prefix) {
  if (typeof value !== 'string' || !value.startsWith(prefix)) return undefined;
  return /^https:\/\/github\.com\/leventozgur\/BrainAtlas\/releases\/[A-Za-z0-9._~/%-]+$/.test(value)
    ? value
    : undefined;
}

/**
 * @param {string|null|undefined} version
 * @returns {boolean}
 */
function isPrereleaseVersion(version) {
  return typeof version === 'string' && /^v?\d+(?:\.\d+)*-/.test(version);
}

/**
 * @param {{currentDir: string, releasesDir: string}} paths
 * @returns {Promise<string|null>}
 */
async function installedVersion(paths) {
  try {
    const current = await readCurrent(paths);
    return current ? current.slice('releases/'.length) : null;
  } catch {
    try {
      const target = await readlink(paths.currentDir);
      const name = target.startsWith(`${paths.releasesDir}/`)
        ? target.slice(paths.releasesDir.length + 1)
        : /^releases\/(.+)$/.exec(target)?.[1];
      if (typeof name !== 'string' || name === '..' || !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(name)) return null;
      return name;
    } catch {
      return null;
    }
  }
}

/**
 * @param {unknown} releases
 * @param {string|null} currentVersion
 * @param {boolean} pre
 * @returns {{version: string, entry: Record<string, any>}|null}
 */
function selectRelease(releases, currentVersion, pre) {
  if (!Array.isArray(releases)) return null;
  const allowPrerelease = pre === true || isPrereleaseVersion(currentVersion);
  let best = null;
  for (const entry of releases) {
    if (!isRecord(entry) || entry.draft === true) continue;
    const tag = entry.tag_name;
    if (typeof tag !== 'string' || !tag.startsWith('v')) continue;
    const version = tag.slice(1);
    if (!validVersion(version)) continue;
    if (entry.prerelease === true && !allowPrerelease) continue;
    if (!best || compareVersions(version, best.version) > 0) best = { version, entry };
  }
  return best;
}

/**
 * @param {Record<string, any>} entry
 * @param {string} version
 * @returns {Record<string, string>}
 */
function releaseAssets(entry, version) {
  /** @type {Record<string,string>} */
  const assets = {};
  const listed = Array.isArray(entry.assets) ? entry.assets : [];
  for (const [key, expected] of Object.entries(UPDATE_ASSET_NAMES)) {
    const name = expected(version);
    const match = listed.find((asset) => isRecord(asset) && asset.name === name);
    const url = match ? prefixedUrl(match.browser_download_url, UPDATE_DOWNLOAD_PREFIX) : undefined;
    if (url) assets[key] = url;
  }
  return assets;
}

/**
 * @param {Record<string, any>} entry
 * @param {string} version
 * @returns {boolean}
 */
function hasDistributionAsset(entry, version) {
  const name = UPDATE_ASSET_NAMES.distribution(version);
  const listed = Array.isArray(entry.assets) ? entry.assets : [];
  return listed.some(
    (asset) =>
      isRecord(asset) &&
      asset.name === name &&
      prefixedUrl(asset.browser_download_url, UPDATE_DOWNLOAD_PREFIX) !== undefined
  );
}

/**
 * @param {{configFile?: string}} paths
 * @param {Record<string, string|undefined>} env
 * @returns {Promise<'lite'|'full'>}
 */
async function installedProfile(paths, env) {
  try {
    const cfg = await loadConfig({ paths, env, readOnly: true });
    return cfg?.profile === 'full' || cfg?.profile === 'custom' ? 'full' : 'lite';
  } catch {
    return 'lite';
  }
}

/**
 * @param {{version: string, profile: 'lite'|'full', hasDistribution: boolean}} options
 * @returns {string[]}
 */
function updateNextLines({ version, profile, hasDistribution }) {
  if (hasDistribution !== true || !validVersion(version)) return [];
  const dir = `brainatlas-${version}`;
  const tag = `v${version}`;
  const distribution = UPDATE_ASSET_NAMES.distribution(version);
  return [
    `mkdir ${dir}`,
    `curl -fL -o ${dir}/${distribution} ${UPDATE_DOWNLOAD_PREFIX}${tag}/${distribution}`,
    `tar -xzf ${dir}/${distribution} -C ${dir}`,
    `# Check that the key fingerprint in ${dir}/release/allowed_signers is SHA256:PPcml0QiRHQJrtPnqWMXF77PgJhPT27GOHboOMJCw40 (ssh-keygen -lf ${dir}/release/allowed_signers)`,
    `ssh-keygen -Y verify -f ${dir}/release/allowed_signers -I brainatlas-release -n brainatlas-release -s ${dir}/SHA256SUMS.sig < ${dir}/SHA256SUMS`,
    `(cd ${dir} && shasum -a 256 -c SHA256SUMS)`,
    `brainatlas update --from ${dir}/brainatlas-${version}-${profile}.tgz`,
  ];
}

/**
 * @param {Record<string, any>} result
 * @returns {string}
 */
function formatUpdateCheck(result) {
  const status =
    result.status === 'available'
      ? `Update available: ${result.currentVersion ?? 'not installed'} -> ${result.offeredVersion}`
      : result.status === 'up-to-date'
        ? `BrainAtlas ${result.currentVersion} is up to date.`
        : `BrainAtlas ${result.currentVersion} is newer than the latest release ${result.offeredVersion}.`;
  return [status, ...(Array.isArray(result.next) ? result.next : [])].join('\n');
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
const HOOK_CLIENTS = Object.freeze({
  'claude-code': 'claude',
  codex: 'codex',
  kiro: 'kiro',
  'copilot-vscode': 'copilot',
  'gemini-cli': 'gemini',
});
const HOOK_INJECTION = Object.freeze({
  'claude-code': 'prompt',
  codex: 'prompt',
  kiro: 'prompt',
  'gemini-cli': 'prompt',
  'copilot-vscode': 'session-start',
});
const DAY_MS = 24 * 60 * 60 * 1000;

function defaultCapabilities(cfg, agent) {
  const channel = effectiveChannel(cfg, agent);
  return {
    channel,
    read: true,
    write: channel === 'mcp' && cfg.readOnly !== true,
    inject: channel === 'mcp' ? (HOOK_INJECTION[agent] ?? 'none') : 'none',
  };
}

export async function doctorResult(paths, env, now = new Date()) {
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
  if (!secretFilterEnabled(cfg)) warnings.push(SECRET_FILTER_OFF_WARNING);
  const capabilities = {};
  const moduleHealth = [];
  if (cfg.agents?.length) {
    for (const agent of cfg.agents) {
      const health = await adapterHealth({ agent, cfg, paths, env });
      if (health.warning) {
        warnings.push(health.warning);
        capabilities[agent] =
          health.warning === `Adapter ${agent} is unavailable.` ? null : defaultCapabilities(cfg, agent);
      } else {
        if (checks.release) checks[`adapter:${agent}`] = health.ok;
        capabilities[agent] = health.capabilities ?? defaultCapabilities(cfg, agent);
        for (const warning of health.warnings || []) warnings.push(`${agent}: ${warning}`);
      }
    }
  }
  for (const [agent, capability] of Object.entries(capabilities)) {
    if (capability && capability.write === false && cfg.readOnly !== true)
      warnings.push(
        `${agent} has no write path (channel ${capability.channel}); run brainatlas agent refresh ${agent}.`
      );
  }
  const hookActivity = {};
  const hookAgents = Object.entries(capabilities).filter(
    ([, capability]) => capability && capability.inject && capability.inject !== 'none'
  );
  if (hookAgents.length && cfg.vault?.path) {
    let records = null;
    try {
      records = await readJsonl(join(paths.stateDir, vaultId(cfg.vault.path), 'metrics', 'hooks.jsonl'));
    } catch (cause) {
      warnings.push(`Hook metrics could not be read (${cause?.code ?? 'error'}).`);
    }
    const lastByClient = new Map();
    for (const record of records || []) {
      if (typeof record.client !== 'string') continue;
      const time = typeof record.ts === 'string' || typeof record.ts === 'number' ? new Date(record.ts).getTime() : NaN;
      if (!Number.isFinite(time)) continue;
      if (!lastByClient.has(record.client) || time > lastByClient.get(record.client))
        lastByClient.set(record.client, time);
    }
    for (const [agent] of hookAgents) {
      const client = HOOK_CLIENTS[agent];
      const last = client ? lastByClient.get(client) : undefined;
      hookActivity[agent] = { lastHookAt: last === undefined ? null : new Date(last).toISOString() };
      if (records === null) continue;
      if (last === undefined) warnings.push(`${agent} hook is installed but has never run.`);
      else {
        const age = now.getTime() - last;
        if (age > 7 * DAY_MS) warnings.push(`${agent} hook last ran ${Math.floor(age / DAY_MS)} days ago.`);
      }
    }
  }
  let orphanState = [];
  if (cfg.vault?.path) {
    try {
      const entries = await readdir(paths.stateDir, { withFileTypes: true });
      const own = vaultId(cfg.vault.path);
      orphanState = entries
        .filter((entry) => entry.isDirectory() && /^[0-9a-f]{16}$/.test(entry.name) && entry.name !== own)
        .map((entry) => entry.name)
        .sort();
    } catch (cause) {
      if (cause?.code !== 'ENOENT') warnings.push(`State directory could not be read (${cause?.code ?? 'error'}).`);
    }
  }
  for (const name of orphanState)
    warnings.push(`State directory ${name} does not belong to the configured vault; remove it after checking.`);
  if (cfg.vault?.path) {
    const policy = await refreshVaultPolicy({ vaultDir: cfg.vault.path, plan: true });
    warnings.push(...policy.warnings);
    for (const change of policy.changes)
      if (change.action !== 'none')
        warnings.push(`${change.path}: the managed policy is out of date; run brainatlas agent refresh.`);
    const references = await lintPolicyReferences({
      vaultDir: cfg.vault.path,
      home: env.HOME,
      knownCommands: commandNames,
    });
    warnings.push(...references.warnings);
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
            // eslint-disable-next-line no-empty
          } catch {}
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
              freshness = index
                ? await semantic.measureIndexFreshness({ corpusDir: join(cfg.vault.path, 'wiki'), index })
                : null;
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
    capabilities,
    hookActivity,
    orphanState,
    moduleHealth,
    warnings,
  };
}
async function removeAdapters(cfg, paths, env) {
  const warnings = [];
  for (const agent of cfg.agents || []) {
    const result = await removeAdapter({ agent, cfg, paths, env });
    if (result.warning) warnings.push(result.warning);
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

function refreshAdapters(paths, env) {
  const failed = (message) => ({ refreshed: [], skipped: [], error: message });
  try {
    const cli = join(paths.currentDir, 'packages', 'cli', 'bin', 'brainatlas.mjs');
    const result = spawnSync(process.execPath, [cli, 'agent', 'refresh', '--safe', '--json'], {
      env,
      encoding: 'utf8',
      timeout: 30000,
    });
    if (result.error) {
      const code = /** @type {{code?: string}} */ (result.error).code;
      return failed(`Agent refresh could not run (${code ?? 'error'}).`);
    }
    if (result.status !== 0) return failed(`Agent refresh exited with status ${result.status}.`);
    let report;
    try {
      report = JSON.parse(result.stdout || '');
    } catch {
      return failed('Agent refresh returned invalid JSON.');
    }
    if (!report || !Array.isArray(report.agents)) return failed('Agent refresh returned invalid JSON.');
    return {
      refreshed: report.agents.map((item) => item?.agent).filter((agent) => typeof agent === 'string'),
      skipped: (Array.isArray(report.skipped) ? report.skipped : [])
        .filter((item) => item && typeof item.agent === 'string')
        .map((item) => ({ agent: item.agent, warnings: Array.isArray(item.warnings) ? item.warnings : [] })),
    };
  } catch {
    return failed('Agent refresh could not run.');
  }
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

export async function summaryInputs({ paths, env }) {
  const doctor = await doctorResult(paths, env);
  const current = await readCurrent(paths);
  const config = await loadConfig({ paths, env }).catch(() => null);
  const agentChannels = config
    ? Object.fromEntries(
        (Array.isArray(config.agents) ? config.agents : []).map((name) => [name, effectiveChannel(config, name)])
      )
    : null;
  return { doctor, currentVersion: current?.slice('releases/'.length) ?? null, config, agentChannels };
}

export async function status({ command, flag, json, output, paths, env }) {
  const result = await doctorResult(paths, env);
  const current = await readCurrent(paths);
  if (command === 'status') {
    const cfg = await loadConfig({ paths, env }).catch(() => null);
    const agentChannels = cfg
      ? Object.fromEntries(
          (Array.isArray(cfg.agents) ? cfg.agents : []).map((name) => [name, effectiveChannel(cfg, name)])
        )
      : null;
    const currentVersion = current?.slice('releases/'.length) ?? null;
    if (flag?.('--summary')) {
      const summary = await buildHealthSummary({
        doctor: result,
        currentVersion,
        config: cfg,
        agentChannels,
        paths,
      });
      output(json ? summary : formatHealthSummary(summary));
    } else output({ ...result, currentVersion, agentChannels });
  } else output({ ...result, currentVersion: current?.slice('releases/'.length) ?? null });
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
    const maintainScheduler = await installedMaintainSchedule('remove', {
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
      ...(maintainScheduler ? { maintainScheduler } : {}),
    });
    return;
  }
  const scheduler = await installedSyncSchedule('remove', { paths, env, config: cfg, dependencies });
  const maintainScheduler = await installedMaintainSchedule('remove', { paths, env, config: cfg, dependencies });
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
      // eslint-disable-next-line no-empty
    } catch {}
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
    ...(maintainScheduler ? { maintainScheduler } : {}),
  });
  return;
}

export async function update({ args, flag, value, json, plan, output, paths, env, dependencies }) {
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
      try {
        const fetchImpl = dependencies.fetch ?? globalThis.fetch;
        const response = await fetchImpl(UPDATE_RELEASES_URL, {
          headers: {
            accept: 'application/vnd.github+json',
            'user-agent': 'brainatlas-update-check',
          },
          signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) throw new Error();
        const body = await response.json();
        const currentVersion = await installedVersion(paths);
        const selected = selectRelease(body, currentVersion, flag('--pre'));
        if (!selected) throw new Error();
        const { version, entry } = selected;
        const order = currentVersion === null ? 1 : compareVersions(version, currentVersion);
        const status = order > 0 ? 'available' : order === 0 ? 'up-to-date' : 'current-newer';
        const releaseUrl = prefixedUrl(entry.html_url, UPDATE_RELEASE_PREFIX);
        const assets = releaseAssets(entry, version);
        /** @type {Record<string, any>} */
        const result = {
          status,
          currentVersion,
          offeredVersion: version,
          prerelease: entry.prerelease === true,
          ...(releaseUrl ? { releaseUrl } : {}),
          assets,
        };
        if (status === 'available') {
          const nextLines = updateNextLines({
            version,
            profile: await installedProfile(paths, env),
            hasDistribution: hasDistributionAsset(entry, version),
          });
          if (nextLines.length > 0) result.next = nextLines;
        }
        output(json ? result : formatUpdateCheck(result));
      } catch (cause) {
        output({ status: 'unknown', reason: cause?.code === 'E_OFFLINE' ? 'offline' : 'metadata-unavailable' });
      }
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
      const adapters = refreshAdapters(paths, env);
      await clearJournal(paths);
      output({ action: 'update', version: manifest.version, profile: manifest.profile, doctor: health, adapters });
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
