// SPDX-License-Identifier: MIT
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHANNEL_AGENTS, effectiveChannel, loadConfig } from '@brainatlas/core';
import { adapterHealth, installAdapter, removeAdapter } from './adapters.mjs';
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
 * Replace a scratch-home prefix with the real home in every string of a plan result.
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
 * Plan the install of the new channel on a clean, empty temporary home and map the paths back to the
 * real home. This is an approximation of the install after the removal. Nothing real is written.
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

/** A removal warning means nothing was removed: stop instead of continuing. @param {{warning?: string}} result */
function requireRemoved(result) {
  if (result.warning)
    throw error(/unavailable/.test(result.warning) ? 'E_AGENT_UNKNOWN' : 'E_ARGUMENT', result.warning);
}

/**
 * `brainatlas agent list | add | remove | set`.
 * @param {{args: string[], paths: any, env: any, output: (data: any) => void, plan: boolean, value: (name: string) => string | undefined}} context
 */
export async function agentCommand({ args, paths, env, output, plan, value }) {
  const action = args.shift();
  if (!['list', 'add', 'remove', 'set'].includes(action ?? '')) throw error('E_ARGUMENT', 'Agent action is invalid.');
  const agent = action === 'list' ? undefined : args.shift();
  if (action !== 'list' && (!agent || agent.startsWith('--'))) throw error('E_ARGUMENT', 'Agent name is required.');
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
      agents.push({
        agent: name,
        installed,
        channel: installed ? effectiveChannel(cfg, name) : null,
        healthy: installed ? (health?.ok ?? false) : null,
      });
    }
    output({ action: 'agent-list', agents });
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
    // Remove files the failed install may have written for the new channel, then restore the old one.
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
