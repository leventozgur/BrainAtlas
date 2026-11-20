// SPDX-License-Identifier: MIT
import { readdir } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { effectiveChannel } from '@brainatlas/core';
import {
  recordManagedWrite,
  recordCreatedDirectories,
  missingDirectories,
  readInstallManifest,
  snapshotPath,
} from '../install-manifest.mjs';
import { adapterConfig, managedRoots } from './shared.mjs';

const adapterRoot = fileURLToPath(new URL('../../../adapters/', import.meta.url));

/** @param {string} directory */
const listNames = (directory) =>
  readdir(directory).catch((cause) => {
    if (cause.code === 'ENOENT') return [];
    throw cause;
  });

/**
 * Evidence-based detection of one adapter. A load failure means not detected.
 * @param {{agent: string, env: any}} options
 * @returns {Promise<{detected: boolean, evidence: string[]}>}
 */
export async function detectAdapter({ agent, env }) {
  try {
    const adapter = await import(pathToFileURL(join(adapterRoot, agent, 'src/index.mjs')).href);
    const result = adapter.detect(env);
    if (result && typeof result.detected === 'boolean' && Array.isArray(result.evidence)) return result;
  } catch {
    /* an adapter that cannot be loaded or probed is not detected */
  }
  return { detected: false, evidence: [] };
}

/**
 * Plan (and unless `plan` is set, apply) the install of one adapter.
 * @param {{agent: string, cfg: any, paths: any, env: any, plan?: boolean}} options
 * @returns {Promise<{changes?: any, warning?: string}>}
 */
export async function installAdapter({ agent, cfg, paths, env, plan }) {
  let available = [];
  try {
    available = await readdir(adapterRoot);
  } catch {
    /* a missing adapters directory means no adapters are available */
  }
  if (!available.includes(agent)) return { warning: `Adapter ${agent} is unavailable.` };
  try {
    const adapter = await import(pathToFileURL(join(adapterRoot, agent, 'src/index.mjs')).href);
    const ctx = {
      env,
      config: adapterConfig(cfg, agent),
      paths,
      scope: cfg.scope,
      nodePath: process.execPath,
      shimPath: paths.binPath,
      now: new Date(),
    };
    if (typeof adapter.plan !== 'function') return { warning: `Adapter ${agent} has no planner.` };
    const changes = await adapter.plan(ctx);
    if (plan) return { changes };
    if (typeof adapter.apply !== 'function') return { changes, warning: `Adapter ${agent} has no apply operation.` };
    const before = new Map();
    const beforeNames = new Map();
    const createdDirectories = [];
    for (const change of changes?.changes || []) {
      const target = resolve(change.file);
      before.set(change.file, await snapshotPath(target));
      const parent = dirname(target);
      createdDirectories.push(...(await missingDirectories(parent, env.HOME, managedRoots(paths, env))));
      if (!beforeNames.has(parent)) beforeNames.set(parent, new Set(await listNames(parent)));
    }
    if (changes?.trustReviewRequired && typeof adapter.trustReview === 'function') await adapter.trustReview(ctx);
    await adapter.apply(changes, ctx);
    for (const change of changes?.changes || []) {
      const file = resolve(change.file);
      await recordManagedWrite(paths, file, {
        before: before.get(change.file),
        after: await snapshotPath(file),
        owner: agent,
        role: 'adapter-config',
      });
    }
    for (const change of changes?.changes || []) {
      const target = resolve(change.file);
      const parent = dirname(target);
      const known = beforeNames.get(parent) || new Set();
      for (const file of await readdir(parent).catch(() => [])) {
        if (file.startsWith(`${basename(target)}.bak.`) && !known.has(file)) {
          const backup = join(parent, file);
          await recordManagedWrite(paths, backup, {
            before: null,
            after: await snapshotPath(backup),
            owner: agent,
            role: 'adapter-backup',
          });
        }
      }
    }
    if (createdDirectories.length)
      await recordCreatedDirectories(paths, createdDirectories, env.HOME, managedRoots(paths, env));
    return { changes };
  } catch (e) {
    if (e.code === 'E_NOT_IMPLEMENTED' || e.code === 'ERR_MODULE_NOT_FOUND')
      return { warning: `Adapter ${agent} is unavailable.` };
    throw e;
  }
}

/**
 * Remove one adapter's managed content. With `plan`, only report what would change.
 * @param {{agent: string, cfg: any, paths: any, env: any, plan?: boolean}} options
 * @returns {Promise<{changes?: any, warning?: string}>}
 */
export async function removeAdapter({ agent, cfg, paths, env, plan }) {
  try {
    const adapter = await import(pathToFileURL(join(adapterRoot, agent, 'src/index.mjs')).href);
    if (typeof adapter.remove !== 'function') return { warning: `Adapter ${agent} has no remove operation.` };
    const ctx = {
      env,
      config: adapterConfig(cfg, agent),
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
        if (
          effectiveChannel(cfg, agent) === 'cli' &&
          (cause?.reason === 'skill-file' || cause?.code === 'E_CHANNEL_SWITCH')
        )
          return { changes: [] };
        throw cause;
      }
    };
    const planned = await planForRemoval();
    const manifest = await readInstallManifest(paths);
    if (plan) {
      const files = new Set(manifest.files.filter((entry) => entry.owners?.includes(agent)).map((entry) => entry.path));
      for (const change of planned?.changes || []) files.add(resolve(change.file));
      return { changes: { changes: [...files].map((file) => ({ file })) } };
    }
    const managed = new Map();
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
      if (!knownNames.has(parent)) knownNames.set(parent, new Set(await listNames(parent)));
    }
    await adapter.remove(ctx);
    for (const [file, before] of managed) {
      const after = await snapshotPath(file);
      if (before?.sha256 !== after?.sha256 || before?.kind !== after?.kind || before?.mode !== after?.mode) {
        await recordManagedWrite(paths, file, { before, after, owner: agent });
      }
      const parent = dirname(file);
      const known = knownNames.get(parent) || new Set();
      for (const name of await listNames(parent)) {
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
    return {};
  } catch (cause) {
    if (cause?.code === 'E_NOT_IMPLEMENTED' || cause?.code === 'ERR_MODULE_NOT_FOUND')
      return { warning: `Adapter ${agent} is unavailable.` };
    throw cause;
  }
}

/**
 * Health of one installed adapter, as computed by `doctor` for `adapter:<agent>`.
 * @param {{agent: string, cfg: any, paths: any, env: any}} options
 * @returns {Promise<{ok?: boolean, warning?: string}>}
 */
export async function adapterHealth({ agent, cfg, paths, env }) {
  try {
    const adapter = await import(pathToFileURL(join(adapterRoot, agent, 'src/index.mjs')).href);
    if (typeof adapter.doctor !== 'function') return { warning: `Adapter ${agent} has no health check.` };
    const report = await adapter.doctor({
      env,
      config: adapterConfig(cfg, agent),
      paths,
      scope: cfg.scope,
      nodePath: cfg.node.path,
      shimPath: paths.binPath,
      now: new Date(),
    });
    return { ok: Boolean(report?.ok) };
  } catch (cause) {
    if (cause?.code === 'ERR_MODULE_NOT_FOUND' || cause?.code === 'E_NOT_IMPLEMENTED')
      return { warning: `Adapter ${agent} is unavailable.` };
    return { ok: false };
  }
}
