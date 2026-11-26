// SPDX-License-Identifier: MIT
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CHANNEL_AGENTS,
  effectiveChannel,
  loadConfig,
  readStandard,
  refreshVaultPolicy,
  standardFromConfig,
  writeStandard,
} from '@brainatlas/core';
import { adapterHealth, detectAdapter, installAdapter, removeAdapter } from './adapters.mjs';
import { error, exists, redactOutput, saveTrackedConfig } from './shared.mjs';

const CHANNELS = ['mcp', 'cli'];
const SWITCH_FAILED = 'Switching the agent channel failed; the previous channel was restored.';
const RESTORE_FAILED = 'Switching the agent channel failed; restoring the previous channel also failed.';

/**
 * @param {any} cfg @param {string} agent @param {string | undefined} channel
 * @returns {any} a copy of `cfg` with `agent` appended (when missing) and its channel set.
 */
function withAgent(cfg, agent, channel) {
  const next = { ...cfg, agents: cfg.agents.includes(agent) ? [...cfg.agents] : [...cfg.agents, agent] };
  if (channel) next.channels = { ...cfg.channels, [agent]: channel };
  return next;
}

/** @param {any} cfg @param {string} agent */
function withoutAgent(cfg, agent) {
  const next = { ...cfg, agents: cfg.agents.filter((item) => item !== agent) };
  if (cfg.channels) {
    const channels = Object.fromEntries(Object.entries(cfg.channels).filter(([name]) => name !== agent));
    if (Object.keys(channels).length) next.channels = channels;
    else delete next.channels;
  }
  return next;
}

/** @param {any} item */
function requireApplied(item) {
  if (item.warning) throw error('E_AGENT_UNKNOWN', item.warning);
}

/**
 * @param {any} value @param {string} scratch @param {string} home @returns {any}
 */
function mapHome(value, scratch, home) {
  if (typeof value === 'string') return value.startsWith(scratch) ? home + value.slice(scratch.length) : value;
  if (Array.isArray(value)) return value.map((item) => mapHome(item, scratch, home));
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapHome(item, scratch, home)]));
  return value;
}

/**
 * @param {{agent: string, cfg: any, paths: any, env: any}} options
 */
async function planInstallOnCleanHome({ agent, cfg, paths, env }) {
  const directory = await mkdtemp(join(tmpdir(), 'brainatlas-agent-plan-'));
  try {
    const scratch = await realpath(directory);
    const result = await installAdapter({ agent, cfg, paths, env: { ...env, HOME: scratch }, plan: true });
    return { changes: mapHome(result.changes ?? null, scratch, env.HOME) };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * @param {{warning?: string}} result
 */
function requireRemoved(result) {
  if (result.warning)
    throw error(/unavailable/.test(result.warning) ? 'E_AGENT_UNKNOWN' : 'E_ARGUMENT', result.warning);
}

/**
 * @param {{args: string[], paths: any, env: any, output: (data: any) => void, plan: boolean, flag?: (name: string) => boolean, value: (name: string) => string | undefined}} context
 */
export async function agentCommand({ args, paths, env, output, plan, flag, value }) {
  const positionals = [];
  for (let index = 0; index < args.length; index++) {
    const token = args[index];
    if (token === '--channel') {
      index++;
      continue;
    }
    if (token.startsWith('--')) continue;
    positionals.push(token);
  }
  const action = positionals.shift();
  if (!['list', 'add', 'remove', 'set', 'refresh'].includes(action ?? ''))
    throw error('E_ARGUMENT', 'Agent action is invalid.');
  const agent = positionals.shift();
  if (positionals.length || (action === 'list' && agent)) throw error('E_ARGUMENT', 'Agent arguments are invalid.');
  if (action !== 'list' && action !== 'refresh' && !agent) throw error('E_ARGUMENT', 'Agent name is required.');
  const channel = value('--channel');
  if (channel !== undefined && !CHANNELS.includes(channel)) throw error('E_ARGUMENT', 'Channel must be mcp or cli.');
  if (action === 'set' && channel === undefined) throw error('E_ARGUMENT', 'Channel is required.');
  if (action !== 'list' && !(await exists(paths.configFile))) throw error('E_ARGUMENT', 'Run brainatlas init first.');
  const cfg = await loadConfig({ paths, env });
  const redact = (data) => redactOutput(data, env.HOME);
  if (action === 'list') {
    const agents = [];
    for (const name of CHANNEL_AGENTS) {
      const installed = cfg.agents.includes(name);
      const health = installed ? await adapterHealth({ agent: name, cfg, paths, env }) : null;
      const { detected, evidence } = await detectAdapter({ agent: name, env });
      agents.push({
        agent: name,
        installed,
        channel: installed ? effectiveChannel(cfg, name) : null,
        healthy: installed ? (health?.ok ?? false) : null,
        detected,
        evidence,
      });
    }
    output({ action: 'agent-list', agents });
    return;
  }
  if (action === 'refresh') {
    if (agent && !cfg.agents.includes(agent)) throw error('E_ARGUMENT', `Agent ${agent} is not installed.`);
    const safe = flag?.('--safe') === true;
    const force = flag?.('--force') === true;
    const refreshed = [];
    const skipped = [];
    let standard = { action: 'none' };
    if (cfg.readOnly !== true) {
      const current = await readStandard(cfg.vault.path);
      if (!current.standard && current.errors.length === 0) {
        if (plan) standard = { action: 'create' };
        else {
          await writeStandard(cfg.vault.path, standardFromConfig(cfg));
          standard = { action: 'create' };
        }
      }
    }
    let policy;
    if (cfg.readOnly === true) {
      const warning = 'vault-policy: readOnly is set; the vault policy was not refreshed.';
      policy = { changes: [], warnings: [warning] };
      skipped.push({ agent: 'vault-policy', warnings: [warning] });
    } else {
      const result = await refreshVaultPolicy({ vaultDir: cfg.vault.path, plan, force });
      policy = { changes: result.changes, warnings: result.warnings };
      if (safe && result.needsConfirmation && !force)
        skipped.push({ agent: 'vault-policy', warnings: result.warnings });
    }
    for (const name of agent ? [agent] : cfg.agents) {
      const warnings = [];
      let changed = [];
      let canApply = true;
      let skippedAgent = false;
      try {
        if (safe) {
          const preview = await installAdapter({ agent: name, cfg, paths, env, plan: true });
          if (preview.warning) {
            warnings.push(preview.warning);
            canApply = false;
          } else if (preview.changes?.needsConfirmation === true) {
            skipped.push({
              agent: name,
              warnings: Array.isArray(preview.changes?.warnings) ? preview.changes.warnings : [],
            });
            canApply = false;
            skippedAgent = true;
          }
        }
        if (canApply) {
          const result = await installAdapter({ agent: name, cfg, paths, env, plan });
          if (result.warning) warnings.push(result.warning);
          if (Array.isArray(result.changes?.warnings)) warnings.push(...result.changes.warnings);
          changed = Array.isArray(result.changes?.changes)
            ? result.changes.changes.map((change) => change?.file).filter((file) => typeof file === 'string')
            : [];
        }
      } catch (cause) {
        warnings.push(`${cause?.code ?? 'error'}: ${cause?.message ?? String(cause)}`);
      }
      if (!skippedAgent) refreshed.push({ agent: name, changed, warnings });
    }
    output({
      action: 'agent-refresh',
      agents: refreshed,
      policy,
      standard,
      ...(safe || skipped.length ? { skipped } : {}),
    });
    return;
  }
  if (action === 'add') {
    if (!CHANNEL_AGENTS.includes(agent)) throw error('E_AGENT_UNKNOWN', 'Unknown agent adapter.');
    if (cfg.agents.includes(agent)) throw error('E_ARGUMENT', `Agent ${agent} is already installed.`);
    const next = withAgent(cfg, agent, channel);
    const result = await installAdapter({ agent, cfg: next, paths, env, plan });
    requireApplied(result);
    if (plan) {
      output({ action: 'agent-add', agent, channel: effectiveChannel(next, agent), changes: redact(result.changes) });
      return;
    }
    await saveTrackedConfig(next, paths, env);
    output({ action: 'agent-add', agent, channel: effectiveChannel(next, agent) });
    return;
  }
  if (!cfg.agents.includes(agent)) throw error('E_ARGUMENT', `Agent ${agent} is not installed.`);
  if (action === 'remove') {
    const result = await removeAdapter({ agent, cfg, paths, env, plan });
    requireRemoved(result);
    if (plan) {
      output({ action: 'agent-remove', agent, changes: redact(result.changes) });
      return;
    }
    await saveTrackedConfig(withoutAgent(cfg, agent), paths, env);
    output({ action: 'agent-remove', agent });
    return;
  }
  const from = effectiveChannel(cfg, agent);
  const changed = from !== channel;
  if (!changed) {
    output({ action: 'agent-set', agent, from, to: channel, changed: false });
    return;
  }
  const next = withAgent(cfg, agent, channel);
  if (plan) {
    const removal = await removeAdapter({ agent, cfg, paths, env, plan });
    requireRemoved(removal);
    const install = await planInstallOnCleanHome({ agent, cfg: next, paths, env });
    output({
      action: 'agent-set',
      agent,
      from,
      to: channel,
      changed,
      remove: redact(removal.changes),
      install: redact(install.changes),
      installApproximate: true,
    });
    return;
  }
  requireRemoved(await removeAdapter({ agent, cfg, paths, env }));
  try {
    requireApplied(await installAdapter({ agent, cfg: next, paths, env }));
  } catch (failure) {
    const codes = [failure?.code ?? 'unknown'];
    try {
      await removeAdapter({ agent, cfg: next, paths, env });
    } catch (cleanup) {
      codes.push(`cleanup: ${cleanup?.code ?? 'unknown'}`);
    }
    let restored = true;
    try {
      requireApplied(await installAdapter({ agent, cfg, paths, env }));
    } catch (restore) {
      restored = false;
      codes.push(`restore: ${restore?.code ?? 'unknown'}`);
    }
    throw error('E_AGENT_SWITCH', `${restored ? SWITCH_FAILED : RESTORE_FAILED} (${codes.join('; ')})`, {
      cause: failure,
    });
  }
  await saveTrackedConfig(next, paths, env);
  output({ action: 'agent-set', agent, from, to: channel, changed });
}
