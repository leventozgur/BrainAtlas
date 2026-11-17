// SPDX-License-Identifier: MIT
import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import * as core from '@brainatlas/core';
import { defaultConfig, loadConfig } from '@brainatlas/core';
import { recordManagedWrite, recordCreatedDirectories, missingDirectories, snapshotPath } from '../install-manifest.mjs';
import { adoptPlan, migrateVault } from '../migrate.mjs';
import { error, exists, managedRoots, saveTrackedConfig, redactOutput } from './shared.mjs';

const vaultInitDirectories = ['wiki/entities', 'wiki/concepts', 'wiki/sources', 'wiki/summaries', 'wiki/queries', 'raw', 'inbox', 'planning'];
const vaultInitFiles = ['wiki/index.md', 'wiki/log.md', 'planning/backlog.md', 'AGENTS.md'];

async function missingVaultInitPaths(vaultPath) {
  const base = resolve(vaultPath);
  const missing = [];
  for (const path of [...vaultInitDirectories, ...vaultInitFiles]) {
    if (!(await exists(join(base, path)))) missing.push(path);
  }
  return missing;
}
async function initializeVault(vaultPath) {
  try { return await core.initVault(vaultPath); }
  catch (cause) {
    // Some packaged releases resolve core templates relative to node_modules; use the CLI's
    // release-root templates only when that lookup fails, while retaining core path checks.
    if (cause?.code !== 'ENOENT') throw cause;
    const requested = resolve(vaultPath);
    await mkdir(requested, { recursive: true });
    const base = await realpath(requested);
    for (const relativePath of vaultInitDirectories) {
      const directory = await core.resolveSafePath(base, relativePath);
      await mkdir(directory, { recursive: true });
    }
    const files = [
      ['wiki/index.md', new URL('../../../../templates/vault/index.md', import.meta.url)],
      ['wiki/log.md', new URL('../../../../templates/vault/log.md', import.meta.url)],
      ['planning/backlog.md', new URL('../../../../templates/vault/backlog.md', import.meta.url)],
      ['AGENTS.md', new URL('../../../../templates/policy/AGENTS.md', import.meta.url)]
    ];
    for (const [relativePath, templateUrl] of files) {
      const file = await core.resolveSafePath(base, relativePath);
      await mkdir(dirname(file), { recursive: true });
      const content = await readFile(templateUrl);
      try { await writeFile(file, content, { flag: 'wx' }); }
      catch (writeError) { if (writeError.code !== 'EEXIST') throw writeError; }
    }
    return { path: base, created: [...vaultInitDirectories, ...files.map(([relativePath]) => relativePath)] };
  }
}

export async function migrate({ value, plan, output }) {
  const from = value('--from'); const to = value('--to');
  if (!from || !to) throw error('E_ARGUMENT', 'migrate requires --from <old-vault> and --to <new-vault>.');
  output(await migrateVault(from, to, { plan })); return;
}

export async function adopt({ plan, output, env }) {
  if (!plan) throw error('E_ARGUMENT', 'adopt requires --plan.');
  output(await adoptPlan(env.HOME)); return;
}

export async function init({ flag, value, plan, output, paths, env }) {
  const requestedVault = value('--vault');
  const requestedProfile = value('--profile');
  const requestedAgents = value('--agents');
  const requestedChannel = value('--channel');
  if (requestedChannel !== undefined && !['mcp', 'cli'].includes(requestedChannel)) throw error('E_ARGUMENT', 'Channel must be mcp or cli.');
  const configExists = await exists(paths.configFile);
  const original = configExists ? await loadConfig({ paths, env }) : null;
  let vault = requestedVault;
  if (!vault && !original && !flag('--yes')) {
    if (!process.stdin.isTTY) throw error('E_ARGUMENT', 'Use --vault or --yes for non-interactive initialization.');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try { vault = await rl.question('Vault path: '); } finally { rl.close(); }
  }
  const cfg = original ? structuredClone(original) : defaultConfig(requestedProfile || 'lite');
  const changes = {};
  const recordChange = (key, before, after) => {
    if (JSON.stringify(before) !== JSON.stringify(after)) changes[key] = { from: before, to: after };
  };
  if (!original) {
    cfg.vault.path = resolve(vault || join(env.HOME, 'BrainAtlas'));
    cfg.node.path = process.execPath;
    cfg.agents = requestedAgents ? requestedAgents.split(',').map(item => item.trim()).filter(Boolean) : [];
    for (const key of ['profile', 'modules', 'vault.path', 'agents']) {
      const before = null;
      const after = key === 'vault.path' ? cfg.vault.path : key.split('.').reduce((value, part) => value[part], cfg);
      recordChange(key, before, after);
    }
  } else {
    if (requestedVault !== undefined) {
      const next = resolve(requestedVault);
      recordChange('vault.path', cfg.vault.path, next);
      cfg.vault.path = next;
    }
    if (requestedProfile !== undefined) {
      const profileConfig = defaultConfig(requestedProfile);
      recordChange('profile', cfg.profile, requestedProfile);
      recordChange('modules', cfg.modules, profileConfig.modules);
      cfg.profile = requestedProfile;
      cfg.modules = profileConfig.modules;
    }
    if (requestedAgents !== undefined) {
      const next = requestedAgents.split(',').map(item => item.trim()).filter(Boolean);
      recordChange('agents', cfg.agents, next);
      cfg.agents = next;
    }
  }
  if (requestedChannel !== undefined) {
    const before = original?.channel ?? null;
    const after = requestedChannel === 'cli' ? 'cli' : null;
    const effective = channel => channel === 'cli' ? 'cli' : 'mcp';
    if (original && (original.agents || []).length && effective(before) !== effective(after)) throw error('E_CHANNEL_SWITCH', 'Run brainatlas uninstall before changing the channel.');
    recordChange('channel', before, after);
    if (after === 'cli') cfg.channel = 'cli'; else delete cfg.channel;
  }
  const agents = cfg.agents;
  const adapterRoot = fileURLToPath(new URL('../../../adapters/', import.meta.url));
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
  const vaultPath = resolve(cfg.vault.path);
  const vaultSummary = { path: vaultPath, created: await missingVaultInitPaths(vaultPath) };
  if (!plan) {
    await initializeVault(vaultPath);
    await saveTrackedConfig(cfg, paths, env);
  }
  output({ action: 'init', configFile: paths.configFile, config: plan ? { changes } : undefined, vault: vaultSummary, warnings, adapters: plan ? plannedAdapters.map(item => redactOutput(item.changes, env.HOME)) : undefined }); return;
}
