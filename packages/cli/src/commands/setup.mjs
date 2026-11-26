// SPDX-License-Identifier: MIT
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import * as core from '@brainatlas/core';
import { CHANNEL_AGENTS, defaultConfig, effectiveChannel, loadConfig } from '@brainatlas/core';
import { adoptPlan, migrateVault } from '../migrate.mjs';
import { error, exists, saveTrackedConfig, redactOutput } from './shared.mjs';
import { detectAdapter, installAdapter } from './adapters.mjs';

const vaultInitDirectories = [
  'wiki/entities',
  'wiki/concepts',
  'wiki/sources',
  'wiki/summaries',
  'wiki/queries',
  'raw',
  'inbox',
  'planning',
];
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
  try {
    return await core.initVault(vaultPath);
  } catch (cause) {
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
      ['AGENTS.md', new URL('../../../../templates/policy/AGENTS.md', import.meta.url)],
    ];
    for (const [relativePath, templateUrl] of files) {
      const file = await core.resolveSafePath(base, relativePath);
      await mkdir(dirname(file), { recursive: true });
      const content = await readFile(templateUrl);
      try {
        await writeFile(file, relativePath === 'AGENTS.md' ? core.managedPolicyBlock(content) : content, {
          flag: 'wx',
        });
      } catch (writeError) {
        if (writeError.code !== 'EEXIST') throw writeError;
      }
    }
    return { path: base, created: [...vaultInitDirectories, ...files.map(([relativePath]) => relativePath)] };
  }
}

export async function migrate({ value, plan, output }) {
  const from = value('--from');
  const to = value('--to');
  if (!from || !to) throw error('E_ARGUMENT', 'migrate requires --from <old-vault> and --to <new-vault>.');
  output(await migrateVault(from, to, { plan }));
  return;
}

export async function adopt({ plan, output, env }) {
  if (!plan) throw error('E_ARGUMENT', 'adopt requires --plan.');
  output(await adoptPlan(env.HOME));
  return;
}

function parseChannelPairs(text) {
  /** @type {Record<string, 'mcp' | 'cli'>} */
  const pairs = {};
  for (const raw of text.split(',')) {
    const parts = raw.split('=').map((part) => part.trim());
    if (parts.length !== 2 || !parts[0] || !parts[1])
      throw error('E_ARGUMENT', 'Channel must be mcp, cli or a list of <agent>=<mcp|cli> pairs.');
    const [agent, channel] = parts;
    if (!CHANNEL_AGENTS.includes(agent)) throw error('E_ARGUMENT', `Channel agent ${agent} is not a known adapter.`);
    if (channel !== 'mcp' && channel !== 'cli') throw error('E_ARGUMENT', `Channel for ${agent} must be mcp or cli.`);
    if (Object.hasOwn(pairs, agent)) throw error('E_ARGUMENT', `Channel for ${agent} is given more than once.`);
    pairs[agent] = channel;
  }
  return pairs;
}

export async function init({ flag, value, plan, output, paths, env }) {
  const requestedVault = value('--vault');
  const requestedProfile = value('--profile');
  const requestedAgents = value('--agents');
  const requestedChannel = value('--channel');
  const channelPairs =
    requestedChannel !== undefined && !['mcp', 'cli'].includes(requestedChannel)
      ? parseChannelPairs(requestedChannel)
      : null;
  const configExists = await exists(paths.configFile);
  const original = configExists ? await loadConfig({ paths, env }) : null;
  let vault = requestedVault;
  if (!vault && !original && !flag('--yes')) {
    if (!process.stdin.isTTY) throw error('E_ARGUMENT', 'Use --vault or --yes for non-interactive initialization.');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      vault = await rl.question('Vault path: ');
    } finally {
      rl.close();
    }
  }
  const cfg = original ? structuredClone(original) : defaultConfig(requestedProfile || 'lite');
  const changes = {};
  const recordChange = (key, before, after) => {
    if (JSON.stringify(before) !== JSON.stringify(after)) changes[key] = { from: before, to: after };
  };
  if (!original) {
    cfg.vault.path = resolve(vault || join(env.HOME, 'BrainAtlas'));
    cfg.node.path = process.execPath;
    cfg.agents = requestedAgents
      ? requestedAgents
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean)
      : [];
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
      const next = requestedAgents
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
      recordChange('agents', cfg.agents, next);
      cfg.agents = next;
    }
  }
  if (channelPairs) {
    for (const agent of Object.keys(channelPairs))
      if (!cfg.agents.includes(agent)) throw error('E_ARGUMENT', `Channel agent ${agent} is not an installed agent.`);
    const before = original?.channels ?? null;
    const after = { ...cfg.channels, ...channelPairs };
    cfg.channels = after;
    recordChange('channels', before, after);
  } else if (requestedChannel !== undefined) {
    const before = original?.channel ?? null;
    const after = requestedChannel === 'cli' ? 'cli' : null;
    recordChange('channel', before, after);
    if (after === 'cli') cfg.channel = 'cli';
    else delete cfg.channel;
  }
  if (requestedChannel !== undefined && original)
    for (const agent of original.agents || [])
      if (effectiveChannel(original, agent) !== effectiveChannel(cfg, agent))
        throw error('E_CHANNEL_SWITCH', 'Run brainatlas uninstall before changing the channel.');
  if (cfg.agents.some((a) => !/^[a-z0-9-]+$/.test(a))) throw error('E_AGENT_UNKNOWN', 'Invalid agent adapter name.');
  const warnings = [];
  const plannedAdapters = [];
  for (const agent of cfg.agents) {
    const result = await installAdapter({ agent, cfg, paths, env, plan });
    if (result.warning) warnings.push(result.warning);
    if (plan && result.changes !== undefined) plannedAdapters.push({ agent, changes: result.changes });
  }
  const vaultPath = resolve(cfg.vault.path);
  const vaultSummary = { path: vaultPath, created: await missingVaultInitPaths(vaultPath) };
  if (!plan) {
    await initializeVault(vaultPath);
    await saveTrackedConfig(cfg, paths, env);
  }
  const detectedAgents = [];
  if (cfg.agents.length === 0)
    for (const agent of CHANNEL_AGENTS) if ((await detectAdapter({ agent, env })).detected) detectedAgents.push(agent);
  output({
    action: 'init',
    configFile: paths.configFile,
    config: plan ? { changes } : undefined,
    vault: vaultSummary,
    warnings,
    adapters: plan ? plannedAdapters.map((item) => redactOutput(item.changes, env.HOME)) : undefined,
    detectedAgents: cfg.agents.length === 0 ? detectedAgents : undefined,
  });
  return;
}
