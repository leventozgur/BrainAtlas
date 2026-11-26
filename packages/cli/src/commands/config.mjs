// SPDX-License-Identifier: MIT
import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  discoverModules,
  fingerprintSafetyFinding,
  loadConfig,
  readModuleManifest,
  resolveModuleOrder,
  scanPath,
  scanText,
  SECRET_FILTER_OFF_WARNING,
  setConfigValue,
  unsetConfigValue,
  activate as activateModule,
} from '@brainatlas/core';
import { inspectReleaseArchive } from '../archive.mjs';
import { error, exists, readCurrent, currentReleaseDir, releaseSigner, saveTrackedConfig } from './shared.mjs';

function normalizeSafetyPath(input) {
  if (
    typeof input !== 'string' ||
    !input ||
    input.startsWith('/') ||
    /^[A-Za-z]:[\\/]/.test(input) ||
    input.includes('\0')
  ) {
    throw error('E_SAFETY_PATH', 'A vault-relative file path is required.');
  }
  const path = input.replace(/\\/g, '/');
  if (path.split('/').some((part) => !part || part === '.' || part === '..'))
    throw error('E_SAFETY_PATH', 'A canonical vault-relative file path is required.');
  return path;
}

async function readSafetyTarget(vaultPath, relPath) {
  let root;
  try {
    root = await realpath(resolve(vaultPath));
  } catch {
    throw error('E_VAULT_NOT_FOUND', 'Configured vault is unavailable.');
  }
  let target = root;
  const parts = relPath.split('/');
  for (let index = 0; index < parts.length; index++) {
    target = join(target, parts[index]);
    let stat;
    try {
      stat = await lstat(target);
    } catch {
      throw error('E_SAFETY_FILE', 'Safety target is unavailable.');
    }
    if (stat.isSymbolicLink() || (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) {
      throw error('E_SAFETY_FILE', 'Safety target must be a regular file inside the vault.');
    }
  }
  let actual;
  try {
    actual = await realpath(target);
  } catch {
    throw error('E_SAFETY_FILE', 'Safety target is unavailable.');
  }
  const rel = relative(root, actual);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw error('E_SAFETY_PATH', 'Safety target must remain inside the vault.');
  let bytes;
  try {
    bytes = await readFile(actual);
  } catch {
    throw error('E_SAFETY_FILE', 'Safety target could not be read.');
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw error('E_SAFETY_ENCODING', 'Safety target is not valid UTF-8 text.');
  }
  return { bytes, text };
}

function safetyFingerprintPrefix(entry) {
  if (entry.sha256) return entry.sha256.slice(0, 12);
  return createHash('sha256').update(`${entry.path}\0${entry.ruleId}`).digest('hex').slice(0, 12);
}

function currentSafetyFindings(path, text, extraDenyGlobs = []) {
  const findings = [...scanPath(path, { extraDenyGlobs }), ...scanText(text)];
  const rows = new Map();
  for (const finding of findings) {
    const fingerprint = fingerprintSafetyFinding(path, text, finding);
    const key = `${fingerprint.path}\0${fingerprint.ruleId}\0${fingerprint.sha256 ?? ''}`;
    if (!rows.has(key))
      rows.set(key, {
        fingerprint,
        ...(finding.kind === 'content' ? { lineNumber: text.slice(0, finding.start).split('\n').length } : {}),
      });
  }
  return [...rows.values()];
}

function publicSafetyEntry(entry, lineNumber) {
  return {
    path: entry.path,
    ruleId: entry.ruleId,
    ...(lineNumber === undefined ? {} : { lineNumber }),
    fingerprint: safetyFingerprintPrefix(entry),
  };
}

function validateArchiveModule(manifest, name) {
  const allowed = new Set([
    'name',
    'version',
    'description',
    'requires',
    'provides',
    'profiles',
    'entry',
    'experimental',
  ]);
  if (
    !manifest ||
    typeof manifest !== 'object' ||
    Array.isArray(manifest) ||
    Object.keys(manifest).some((key) => !allowed.has(key)) ||
    manifest.name !== name ||
    !/^[a-z0-9][a-z0-9._-]*$/.test(manifest.name) ||
    typeof manifest.version !== 'string' ||
    !manifest.version.trim() ||
    typeof manifest.description !== 'string' ||
    !manifest.description.trim() ||
    !Array.isArray(manifest.requires) ||
    !manifest.requires.every((item) => typeof item === 'string' && /^[a-z0-9][a-z0-9._-]*$/.test(item)) ||
    !Array.isArray(manifest.provides) ||
    !manifest.provides.every((item) => typeof item === 'string' && item.trim()) ||
    !Array.isArray(manifest.profiles) ||
    !manifest.profiles.length ||
    !manifest.profiles.every((item) => ['lite', 'full', 'custom'].includes(item)) ||
    typeof manifest.entry !== 'string' ||
    !manifest.entry ||
    manifest.entry === '.' ||
    manifest.entry.startsWith('/') ||
    manifest.entry.includes('\\') ||
    manifest.entry.split('/').some((part) => !part || part === '.' || part === '..') ||
    (manifest.experimental !== undefined && typeof manifest.experimental !== 'boolean')
  )
    throw error('E_MODULE_MANIFEST', 'Module manifest is invalid.');
  return manifest;
}

export async function moduleCommand({ args, paths, env, output, plan, value }) {
  const action = args.shift();
  if (!['add', 'remove', 'list'].includes(action)) throw error('E_ARGUMENT', 'Module action is invalid.');
  const name = action === 'list' ? undefined : args.shift();
  if (name && !/^[a-z0-9][a-z0-9._-]*$/.test(name)) throw error('E_ARGUMENT', 'Module name is invalid.');
  const current = await readCurrent(paths);
  const releaseDir = currentReleaseDir(paths, current);
  if (!releaseDir) throw error('E_RELEASE_MISSING', 'No release is installed.');
  const cfg = await loadConfig({ paths, env });
  if (action === 'list') {
    const manifests = await discoverModules(releaseDir);
    const enabled = new Set(cfg.modules.includes('*') ? manifests.map((item) => item.name) : cfg.modules);
    output({
      modules: manifests.map((item) => ({ name: item.name, version: item.version, active: enabled.has(item.name) })),
    });
    return;
  }
  if (action === 'remove') {
    const directory = join(releaseDir, 'modules', name);
    if (!(await exists(directory))) throw error('E_MODULE_MISSING', 'Module is not installed.');
    readModuleManifest(directory);
    const manifests = await discoverModules(releaseDir);
    const remaining = manifests.filter(
      (item) => item.name !== name && (cfg.modules.includes('*') || cfg.modules.includes(item.name))
    );
    if (remaining.some((item) => item.requires.includes(name)))
      throw error('E_MODULE_DEPENDENCY', 'Another enabled module requires this module.');
    const modules = cfg.modules.includes('*')
      ? remaining.map((item) => item.name)
      : cfg.modules.filter((item) => item !== name);
    if (plan) {
      output({ action: 'module remove', name, modules });
      return;
    }
    await rm(directory, { recursive: true, force: true });
    const updated = setConfigValue(cfg, 'modules', modules);
    await saveTrackedConfig(updated, paths, env);
    output({ action: 'module remove', name });
    return;
  }
  const archive = value('--from');
  if (!archive) throw error('E_ARGUMENT', 'module add requires --from <full.tgz>.');
  const { manifest: release, files, prefix } = await inspectReleaseArchive(resolve(archive), releaseSigner(paths, env));
  if (release.profile !== 'full') throw error('E_PROFILE_MISMATCH', 'Modules can only be added from a full release.');
  const modulePrefix = `${prefix}modules/${name}/`;
  const moduleBytes = files.get(`${modulePrefix}module.json`);
  if (!moduleBytes || !release.modules.includes(name))
    throw error('E_MODULE_MISSING', 'Module is missing from the full release.');
  const manifests = new Map();
  const collect = (moduleName) => {
    if (manifests.has(moduleName)) return;
    const bytes = files.get(`${prefix}modules/${moduleName}/module.json`);
    if (!bytes || !release.modules.includes(moduleName))
      throw error('E_MODULE_DEPENDENCY', 'A required module is missing from the full release.');
    let parsed;
    try {
      parsed = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw error('E_MODULE_MANIFEST', 'Module manifest is invalid.');
    }
    const validated = validateArchiveModule(parsed, moduleName);
    manifests.set(moduleName, validated);
    for (const dependency of validated.requires) collect(dependency);
  };
  collect(name);
  const ordered = resolveModuleOrder([...manifests.values()]);
  const existing = new Set(
    await readdir(join(releaseDir, 'modules')).catch((cause) => {
      if (cause.code === 'ENOENT') return [];
      throw cause;
    })
  );
  const installNames = ordered.map((item) => item.name).filter((item) => !existing.has(item));
  if (existing.has(name)) throw error('E_MODULE_EXISTS', 'Module is already installed.');
  const cfgModules = new Set(cfg.modules);
  const nextModules = cfg.modules.includes('*')
    ? cfg.modules
    : [...cfg.modules, ...ordered.map((item) => item.name).filter((item) => !cfgModules.has(item))];
  if (plan) {
    output({ action: 'module add', modules: installNames, configModules: nextModules });
    return;
  }
  const installedDirs = [];
  let activationConfig = cfg;
  try {
    for (const moduleName of installNames) {
      const destination = join(releaseDir, 'modules', moduleName);
      await mkdir(destination, { recursive: true });
      installedDirs.push(destination);
      const sourcePrefix = `${prefix}modules/${moduleName}/`;
      for (const [archiveName, bytes] of files) {
        if (!archiveName.startsWith(sourcePrefix)) continue;
        const relativeName = archiveName.slice(sourcePrefix.length);
        if (!relativeName || relativeName.split('/').some((part) => !part || part === '.' || part === '..'))
          throw error('E_MANIFEST_INVALID', 'Module path is invalid.');
        const target = join(destination, relativeName);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, bytes, { flag: 'wx', mode: 0o644 });
      }
    }
    if (!cfg.modules.includes('*')) {
      activationConfig = setConfigValue(cfg, 'modules', nextModules);
      await saveTrackedConfig(activationConfig, paths, env);
    }
    const logger = Object.freeze({ info() {}, warn() {}, error() {} });
    const warnings = [];
    for (const moduleManifest of ordered) {
      if (!installNames.includes(moduleManifest.name)) continue;
      try {
        await activateModule({
          moduleDir: join(releaseDir, 'modules', moduleManifest.name),
          manifest: moduleManifest,
          config: activationConfig,
          paths,
          env,
          core: {},
          logger,
        });
      } catch (cause) {
        if (cause?.code === 'E_NOT_IMPLEMENTED') warnings.push(`${moduleManifest.name} installed inactive.`);
        else throw cause;
      }
    }
    output({ action: 'module add', modules: installNames, warnings });
  } catch (cause) {
    for (const directory of installedDirs.reverse()) await rm(directory, { recursive: true, force: true });
    if (!cfg.modules.includes('*')) await saveTrackedConfig(cfg, paths, env).catch(() => {});
    throw cause;
  }
}

export async function safety({ args, plan, output, paths, env }) {
  const action = args.shift();
  const positional = args.filter((argument) => !argument.startsWith('--'));
  if (args.some((argument) => argument.startsWith('--') && !['--json', '--plan'].includes(argument)))
    throw error('E_ARGUMENT', 'Safety command arguments are invalid.');
  const cfg = await loadConfig({ paths, env, readOnly: true });
  const existing = Array.isArray(cfg.safety.allow) ? cfg.safety.allow : [];
  if (action === 'list') {
    if (positional.length > 1) throw error('E_ARGUMENT', 'Safety list accepts at most one path.');
    const filterPath = positional.length ? normalizeSafetyPath(positional[0]) : null;
    const entries = existing
      .filter((entry) => filterPath === null || entry.path === filterPath)
      .map((entry) => publicSafetyEntry(entry));
    output({ action: 'safety list', entries });
    return;
  }
  if (action === 'allow') {
    if (positional.length !== 1) throw error('E_ARGUMENT', 'Safety allow requires one vault-relative path.');
    const path = normalizeSafetyPath(positional[0]);
    const { text } = await readSafetyTarget(cfg.vault.path, path);
    const findings = currentSafetyFindings(path, text, cfg.safety.extraDenyGlobs);
    if (!findings.length) throw error('E_SAFETY_CLEAN', 'Safety target has no current findings.');
    const next = [...existing];
    for (const { fingerprint } of findings) {
      if (
        !next.some(
          (entry) =>
            entry.path === fingerprint.path &&
            entry.ruleId === fingerprint.ruleId &&
            entry.sha256 === fingerprint.sha256 &&
            Object.hasOwn(entry, 'sha256') === Object.hasOwn(fingerprint, 'sha256')
        )
      )
        next.push(fingerprint);
    }
    if (!plan && next.length !== existing.length) {
      const updated = structuredClone(cfg);
      updated.safety.allow = next;
      await saveTrackedConfig(updated, paths, env);
    }
    output({
      action: 'safety allow',
      path,
      entries: findings.map(({ fingerprint, lineNumber }) => publicSafetyEntry(fingerprint, lineNumber)),
    });
    return;
  }
  if (action === 'revoke') {
    if (positional.length !== 1) throw error('E_ARGUMENT', 'Safety revoke requires one vault-relative path.');
    const path = normalizeSafetyPath(positional[0]);
    const next = existing.filter((entry) => entry.path !== path);
    const revoked = existing.length - next.length;
    if (!plan && revoked) {
      const updated = structuredClone(cfg);
      updated.safety.allow = next;
      await saveTrackedConfig(updated, paths, env);
    }
    output({ action: 'safety revoke', path, revoked });
    return;
  }
  throw error('E_ARGUMENT', 'Safety action must be allow, list, or revoke.');
}

export async function configCommand({ args, plan, output, paths, env, markRedacted }) {
  const action = args.shift();
  const key = args.shift();
  const cfg = await loadConfig({ paths, env });
  if (action === 'get') {
    if (key && !key.startsWith('--') && !/^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*$/.test(key))
      throw error('E_CONFIG_KEY', 'Invalid configuration key.');
    const result = key && !key.startsWith('--') ? key.split('.').reduce((v, k) => v?.[k], cfg) : cfg;
    if (result === undefined) throw error('E_CONFIG_KEY', 'Unknown configuration key.');
    markRedacted();
    output(result);
    return;
  }
  if ((action === 'set' || action === 'unset') && (key === 'channels' || key?.startsWith('channels.')))
    throw error('E_CHANNEL_SWITCH', "Use brainatlas init --channel <agent>=<mcp|cli> to change an agent's channel.");
  if (action === 'set') {
    if (!key || !/^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*$/.test(key))
      throw error('E_CONFIG_KEY', 'Invalid configuration key.');
    const raw = args.shift();
    if (raw === undefined || raw.startsWith('--')) throw error('E_ARGUMENT', 'Missing configuration value.');
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = raw;
    }
    const updated = setConfigValue(cfg, key, parsed);
    if (!plan) await saveTrackedConfig(updated, paths, env);
    let credentialUrl = false;
    if (key === 'sync.options.remote' && typeof parsed === 'string' && /^https:\/\//i.test(parsed)) {
      try {
        const remote = new URL(parsed);
        credentialUrl = Boolean(remote.username || remote.password);
        // eslint-disable-next-line no-empty
      } catch {}
    }
    const warnings = credentialUrl
      ? ['Remote URL contains embedded credentials; use a credential helper instead.']
      : [];
    if (key === 'safety.secretFilter' && parsed === false) warnings.push(SECRET_FILTER_OFF_WARNING);
    for (const warning of warnings) console.error(warning);
    output({ action: 'config set', key, ...(warnings.length ? { warnings } : {}) });
    return;
  }
  if (action === 'unset') {
    if (!key || !/^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*$/.test(key))
      throw error('E_CONFIG_KEY', 'Invalid configuration key.');
    const updated = unsetConfigValue(cfg, key);
    if (!plan && JSON.stringify(updated) !== JSON.stringify(cfg)) await saveTrackedConfig(updated, paths, env);
    output({ action: 'config unset', key });
    return;
  }
  throw error('E_ARGUMENT', 'Configuration action is invalid.');
}
