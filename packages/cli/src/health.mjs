// SPDX-License-Identifier: MIT
import { join } from 'node:path';
import { checkVault, vaultId } from '@brainatlas/core';
import { runMaintenance } from './maintain.mjs';
import { readJsonl } from './usage.mjs';

const DAY_MS = 86_400_000;

async function okfCounts(vaultPath) {
  try {
    const findings = await checkVault(vaultPath);
    return {
      errors: findings.filter((item) => item.severity === 'error').length,
      warnings: findings.filter((item) => item.severity === 'warn').length,
    };
  } catch {
    return null;
  }
}

async function maintainCounts(vaultPath) {
  try {
    const report = await runMaintenance(vaultPath);
    const nonzero = Object.fromEntries(Object.entries(report.counts).filter(([, count]) => count > 0));
    return { total: report.findings.length, byKind: nonzero };
  } catch {
    return null;
  }
}

async function hookSemantic(stateDir, now, days = 7) {
  try {
    const records = await readJsonl(join(stateDir, 'metrics', 'hooks.jsonl'));
    const from = now.getTime() - days * DAY_MS;
    const prompts = records.filter((record) => {
      const at = Date.parse(record.ts ?? record.at ?? '');
      return record.event === 'prompt' && typeof record.semantic === 'string' && (Number.isNaN(at) || at >= from);
    });
    if (!prompts.length) return null;
    const used = prompts.filter((record) => record.semantic === 'used').length;
    const reasons = {};
    for (const record of prompts)
      if (record.semantic !== 'used') reasons[record.semantic] = (reasons[record.semantic] ?? 0) + 1;
    return { days, prompts: prompts.length, used, otherOutcomes: reasons };
  } catch {
    return null;
  }
}

export async function buildHealthSummary({ doctor, currentVersion, config, agentChannels, paths, now = new Date() }) {
  const vaultPath = config?.vault?.path;
  const stateDir = vaultPath ? join(paths.stateDir, vaultId(vaultPath)) : null;
  const sync = doctor.moduleHealth?.find((item) => item.name === 'sync') ?? null;
  const semantic = doctor.moduleHealth?.find((item) => item.name === 'semantic') ?? null;
  const [okf, maintain, hook] = await Promise.all([
    vaultPath ? okfCounts(vaultPath) : null,
    vaultPath ? maintainCounts(vaultPath) : null,
    stateDir ? hookSemantic(stateDir, now) : null,
  ]);
  return {
    ok: doctor.ok,
    version: currentVersion,
    profile: doctor.profile,
    modules: doctor.modules,
    agentChannels,
    capabilities: doctor.capabilities ?? null,
    hooks: config?.hooks ? { mode: config.hooks.mode, deadlineMs: config.hooks.deadlineMs } : null,
    semantic: {
      enabled: semantic?.enabled === true,
      index: semantic?.freshness ?? null,
      hookRecent: hook,
    },
    sync: sync ? { transport: sync.transport, status: sync.status, lastSync: sync.lastSync } : null,
    okf,
    maintain,
    warnings: doctor.warnings,
    note: 'wiki lint, okf check and maintain check different rules; this view lists them side by side.',
  };
}

const list = (items) => (items?.length ? items.join(', ') : 'none');

export function formatHealthSummary(summary) {
  const rows = [
    ['Health', summary.ok ? 'ok' : 'problems found (run brainatlas doctor)'],
    ['Version', summary.version ?? 'unknown'],
    ['Profile', summary.profile],
    ['Modules', list(summary.modules)],
    [
      'Agents',
      summary.agentChannels === null
        ? 'unknown'
        : list(Object.entries(summary.agentChannels ?? {}).map(([name, channel]) => `${name}=${channel}`)),
    ],
    ['Hooks', summary.hooks ? `${summary.hooks.mode} (deadline ${summary.hooks.deadlineMs} ms)` : 'unknown'],
  ];
  const sem = summary.semantic;
  let semantic = sem.enabled ? 'enabled' : 'off';
  if (sem.enabled && sem.index)
    semantic += `, index ${sem.index.indexed} indexed / ${sem.index.stale} stale / ${sem.index.missing} missing`;
  if (sem.hookRecent)
    semantic += `, hook used ${sem.hookRecent.used}/${sem.hookRecent.prompts} prompts in ${sem.hookRecent.days} days`;
  rows.push(['Semantic', semantic]);
  rows.push([
    'Sync',
    summary.sync
      ? `${summary.sync.status} via ${summary.sync.transport ?? 'none'}, last ${summary.sync.lastSync ?? 'never'}`
      : 'not installed',
  ]);
  rows.push([
    'OKF',
    summary.okf ? `${summary.okf.errors} errors, ${summary.okf.warnings} warnings (core rules)` : 'unavailable',
  ]);
  rows.push([
    'Maintain',
    summary.maintain
      ? summary.maintain.total
        ? `${summary.maintain.total} findings: ${Object.entries(summary.maintain.byKind)
            .map(([kind, count]) => `${kind} ${count}`)
            .join(', ')}`
        : 'no findings'
      : 'unavailable',
  ]);
  const width = Math.max(...rows.map(([label]) => label.length));
  const lines = rows.map(([label, value]) => `${label.padEnd(width)}  ${value}`);
  for (const [agent, capability] of Object.entries(summary.capabilities ?? {})) {
    lines.push(
      capability
        ? `${agent}: ${capability.channel}, read ${capability.read ? 'yes' : 'no'}, write ${capability.write ? 'yes' : 'no'}, inject ${capability.inject}`
        : `${agent}: unavailable`
    );
  }
  for (const warning of summary.warnings ?? []) lines.push(`warning: ${warning}`);
  lines.push('', summary.note);
  return lines.join('\n');
}
