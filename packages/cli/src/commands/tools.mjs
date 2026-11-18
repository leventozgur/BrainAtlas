// SPDX-License-Identifier: MIT
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, vaultId } from '@brainatlas/core';
import { recordCreatedDirectories, missingDirectories } from '../install-manifest.mjs';
import { formatMaintenance, receiptCandidates, runMaintenance } from '../maintain.mjs';
import { applyCompaction, formatCompaction, planCompaction } from '../compact.mjs';
import { applyFix, formatFix, planFix } from '../maintain-fix.mjs';
import { runWeeklyMaintenance, weeklyReminder } from '../maintain-weekly.mjs';
import {
  acceptProposal,
  formatProposalResult,
  listProposals,
  rejectProposal,
  showProposal,
} from '../synthesis/review.mjs';
import { formatUsage, isFeedbackVerdict, recordFeedback, usageSummary } from '../usage.mjs';
import {
  error,
  readCurrent,
  currentReleaseDir,
  managedRoots,
  enabledModuleEntries,
  moduleContext,
  activateEnabledModules,
} from './shared.mjs';

export async function hookCommandFor({ client, event, paths, config }) {
  if (
    !['claude', 'codex', 'kiro', 'copilot', 'gemini'].includes(client) ||
    !['prompt', 'session-start', 'session-end'].includes(event)
  )
    throw error('E_HOOK_CLIENT', 'Hook client or event is invalid.');
  let component;
  try {
    component = await import('@brainatlas/hooks');
  } catch (cause) {
    if (cause.code === 'ERR_MODULE_NOT_FOUND') throw error('E_COMPONENT_MISSING', 'Hook component is unavailable.');
    throw cause;
  }
  if (typeof component.buildHookCommand !== 'function')
    throw error('E_COMPONENT_MISSING', 'Hook command builder is unavailable.');
  const state = join(paths.stateDir, vaultId(config.vault.path));
  await mkdir(state, { recursive: true });
  return component.buildHookCommand({
    nodePath: process.execPath,
    shimPath: paths.binPath,
    client,
    event,
    paths: { vault: config.vault.path, state, release: paths.currentDir, configFile: paths.configFile },
  });
}

async function queueSessionEndReceipt({ client, hookInput, config, paths, env }) {
  const operation = (async () => {
    const current = await readCurrent(paths);
    const releaseDir = currentReleaseDir(paths, current);
    if (!releaseDir) return;
    const { ordered, entries } = await enabledModuleEntries(releaseDir, config);
    const handler = ordered
      .map((manifest) => entries.get(manifest.name))
      .find((entry) => typeof entry?.onSessionEnd === 'function');
    if (!handler) return;
    const ctx = moduleContext(config, paths, env, entries, ordered);
    await activateEnabledModules(ordered, entries, ctx);
    await handler.onSessionEnd(ctx, { ...hookInput, client });
  })();
  let timer;
  const deadline = Math.max(1, Number(config.hooks?.deadlineMs) || 1000);
  try {
    return await Promise.race([
      operation.then(
        () => true,
        () => false
      ),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), deadline);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Queue one review candidate per finding kind through the installed receipts module (Full). Lite: nothing is written. */
async function queueMaintenanceReceipt({ config, paths, env, candidates }) {
  const current = await readCurrent(paths).catch(() => null);
  const releaseDir = currentReleaseDir(paths, current);
  if (!releaseDir) return { queued: false, reason: 'receipts-module-missing' };
  const { ordered, entries } = await enabledModuleEntries(releaseDir, config);
  const handler = ordered
    .map((manifest) => entries.get(manifest.name))
    .find((entry) => typeof entry?.onSessionEnd === 'function');
  if (!handler) return { queued: false, reason: 'receipts-module-missing' };
  const cfg = structuredClone(config);
  cfg.stateDir = join(paths.stateDir, vaultId(config.vault.path));
  const roots = managedRoots(paths, env);
  const created = await missingDirectories(cfg.stateDir, env.HOME, roots);
  await mkdir(cfg.stateDir, { recursive: true });
  if (created.length) await recordCreatedDirectories(paths, created, env.HOME, roots);
  const ctx = moduleContext(cfg, paths, env, entries, ordered);
  await activateEnabledModules(ordered, entries, ctx);
  const result = await handler.onSessionEnd(ctx, {
    client: 'claude',
    session_id: 'brainatlas-maintain',
    brainatlas_receipt: candidates,
  });
  return { queued: Boolean(result?.queued), id: result?.id, candidates: result?.candidates ?? 0 };
}

export async function wiki({ args, json, output, env }) {
  const { formatWikiResult, runWikiCommand } = await import('../wiki.mjs');
  const result = await runWikiCommand(args, { env });
  if (json) {
    output(result.value);
    return;
  }
  const text = formatWikiResult(result.sub, result.value);
  if (text) console.log(text);
  return;
}

export async function compact({ flag, value, plan, json, output, paths, env }) {
  const page = value('--page');
  if (!page) throw error('E_ARGUMENT', 'compact requires --page <wiki/...md>.');
  const apply = flag('--apply');
  if (plan === apply) throw error('E_ARGUMENT', 'compact requires exactly one of --plan or --apply.');
  const rawKeep = value('--keep');
  let keep = 3;
  if (rawKeep !== undefined) {
    if (!/^\d+$/u.test(rawKeep) || Number(rawKeep) > 1000)
      throw error('E_ARGUMENT', 'compact --keep must be an integer from 0 to 1000.');
    keep = Number(rawKeep);
  }
  const olderThan = value('--older-than') ?? null;
  const requested = value('--vault');
  const vaultPath = requested === undefined ? (await loadConfig({ paths, env, readOnly: true })).vault.path : requested;
  const result = plan
    ? await planCompaction(vaultPath, { page, keep, olderThan })
    : await applyCompaction(vaultPath, { page, keep, olderThan });
  if (json) {
    output(result);
    return;
  }
  console.log(formatCompaction(result));
  return;
}

export async function maintain({ args, flag, value, json, plan, output, paths, env, dependencies }) {
  const requested = value('--vault');
  const repo = value('--repo');
  const queue = flag('--queue');
  const fix = flag('--fix');
  const sources = flag('--sources');
  const weekly = flag('--weekly');
  const proposals = value('--proposals');
  if (args.includes('--schedule'))
    throw error(
      'E_ARGUMENT',
      'maintain does not support --schedule; run "brainatlas maintain --weekly" from your own scheduler.'
    );
  if (proposals !== undefined) {
    if (weekly || fix || queue || sources || repo !== undefined) {
      throw error(
        'E_ARGUMENT',
        'maintain --proposals cannot be combined with --weekly, --fix, --queue, --sources or --repo.'
      );
    }
    const tokens = [];
    for (let index = args.indexOf('--proposals') + 1; index < args.length; index++) {
      const token = args[index];
      if (token === '--json') continue;
      if (token === '--vault') {
        index++;
        continue;
      }
      if (token.startsWith('--'))
        throw error('E_ARGUMENT', 'maintain --proposals accepts list, show <id>, accept <id> or reject <id>.');
      tokens.push(token);
    }
    const action = tokens.shift();
    if (!['list', 'show', 'accept', 'reject'].includes(action)) {
      throw error('E_ARGUMENT', 'maintain --proposals requires list, show <id>, accept <id> or reject <id>.');
    }
    if ((action === 'list' && tokens.length) || (action !== 'list' && tokens.length !== 1)) {
      throw error('E_ARGUMENT', 'maintain --proposals list takes no id; show, accept and reject take exactly one id.');
    }
    let vaultPath;
    if (action === 'accept') {
      // Accept is the only proposal action that writes the vault: it only ever writes the configured vault.
      const cfg = await loadConfig({ paths, env, readOnly: true }).catch(() => null);
      const target = requested ?? cfg?.vault?.path;
      if (!cfg || !target || resolve(target) !== resolve(cfg.vault.path))
        throw error('E_NOT_CONFIGURED_VAULT', 'maintain --proposals accept only writes to the configured vault.');
      vaultPath = target;
    } else {
      vaultPath = requested === undefined ? (await loadConfig({ paths, env, readOnly: true })).vault.path : requested;
    }
    const stateDir = join(paths.stateDir, vaultId(resolve(vaultPath)));
    const now = new Date();
    let result;
    if (action === 'list') result = await listProposals({ stateDir, now });
    else if (action === 'show') result = await showProposal({ vault: vaultPath, stateDir, id: tokens[0], now, env });
    else if (action === 'accept')
      result = await acceptProposal({ vault: vaultPath, stateDir, id: tokens[0], now, env });
    else result = await rejectProposal({ stateDir, id: tokens[0] });
    output(json ? result : formatProposalResult(result));
    return;
  }
  if (weekly) {
    if (fix || queue || sources || repo !== undefined)
      throw error('E_ARGUMENT', 'maintain --weekly cannot be combined with --fix, --queue, --sources or --repo.');
    const cfg =
      requested === undefined
        ? await loadConfig({ paths, env, readOnly: true })
        : await loadConfig({ paths, env, readOnly: true }).catch(() => null);
    const vaultPath = requested ?? cfg.vault.path;
    const configured = Boolean(cfg) && resolve(vaultPath) === resolve(cfg.vault.path);
    const queued = configured ? (candidates) => queueMaintenanceReceipt({ config: cfg, paths, env, candidates }) : null;
    const { snapshot, text } = await runWeeklyMaintenance(vaultPath, {
      paths,
      env,
      queue: queued,
      config: cfg,
      runCommand: dependencies?.runCommand,
      configuredVault: configured,
    });
    output(json ? snapshot : text);
    return;
  }
  if (fix) {
    const apply = flag('--apply');
    if (queue) throw error('E_ARGUMENT', 'maintain --fix cannot be combined with --queue.');
    if (repo !== undefined) throw error('E_ARGUMENT', 'maintain --fix cannot be combined with --repo.');
    if (plan === apply) throw error('E_ARGUMENT', 'maintain --fix requires exactly one of --plan or --apply.');
    const vaultPath =
      requested === undefined ? (await loadConfig({ paths, env, readOnly: true })).vault.path : requested;
    const result = plan ? await planFix(vaultPath, { sources }) : await applyFix(vaultPath, { sources });
    if (json) {
      output(result);
      return;
    }
    console.log(formatFix(result));
    return;
  }
  if (sources) throw error('E_ARGUMENT', 'maintain --sources requires --fix.');
  const cfg = requested === undefined || queue ? await loadConfig({ paths, env }) : null;
  if (queue && requested !== undefined && resolve(requested) !== resolve(cfg.vault.path))
    throw error('E_ARGUMENT', '--queue only works with the configured vault.');
  const report = await runMaintenance(requested ?? cfg.vault.path, repo === undefined ? {} : { repo });
  if (queue) {
    const candidates = receiptCandidates(report.findings);
    report.queue = candidates.length
      ? await queueMaintenanceReceipt({ config: cfg, paths, env, candidates })
      : { queued: false, reason: 'no-findings' };
  }
  const reminder = requested === undefined && cfg ? await weeklyReminder({ paths, vaultPath: cfg.vault.path }) : null;
  if (json) {
    if (reminder) report.weekly = { lastRun: reminder.lastRun, overdue: true };
    output(report);
    return;
  }
  const text = formatMaintenance(report);
  const lines = queue
    ? [
        text,
        report.queue.queued
          ? `Queued ${report.queue.candidates} review candidate(s) for receipts review.`
          : `Nothing queued (${report.queue.reason}).`,
      ]
    : [text];
  if (reminder) lines.push(reminder.line);
  output(lines.join('\n'));
  return;
}

export async function usage({ args, value, json, output, paths, env }) {
  const rawDays = value('--days');
  let days = 7;
  if (rawDays !== undefined) {
    const parsedDays = Number(rawDays);
    if (!/^\d+$/.test(rawDays) || !Number.isSafeInteger(parsedDays) || parsedDays < 1)
      throw error('E_ARGUMENT', 'Usage --days must be an integer of at least 1.');
    days = parsedDays;
  }
  const positional = [];
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--json') continue;
    if (argument === '--days') {
      index++;
      continue;
    }
    if (argument.startsWith('--')) throw error('E_ARGUMENT', 'Usage arguments are invalid.');
    positional.push(argument);
  }
  const feedbackAction = positional[0] === 'feedback';
  if (feedbackAction && (positional.length !== 2 || !isFeedbackVerdict(positional[1])))
    throw error('E_ARGUMENT', 'Feedback verdict must be useful or not-useful.');
  if (feedbackAction && rawDays !== undefined) throw error('E_ARGUMENT', 'Usage --days is only valid for the summary.');
  if (!feedbackAction && positional.length) throw error('E_ARGUMENT', 'Usage arguments are invalid.');
  const cfg = await loadConfig({ paths, env });
  const stateDir = join(paths.stateDir, vaultId(cfg.vault.path));
  if (feedbackAction) {
    const result = await recordFeedback({ stateDir, verdict: positional[1] });
    output(json ? result : `Recorded feedback: ${positional[1]}.`);
    return;
  }
  const summary = await usageSummary({ stateDir, days });
  output(json ? summary : formatUsage(summary));
  return;
}

export async function evalCommand({ value, output }) {
  let component;
  try {
    component = await import(/** @type {any} */ (new URL('../../../../eval/run-eval.mjs', import.meta.url)));
  } catch (e) {
    if (e.code === 'ERR_MODULE_NOT_FOUND') throw error('E_COMPONENT_MISSING', 'Evaluation component is unavailable.');
    throw e;
  }
  if (typeof component.runEval !== 'function')
    throw error('E_COMPONENT_MISSING', 'Evaluation component is unavailable.');
  const evalDir = new URL('../../../../eval/', import.meta.url);
  try {
    output(
      component.runEval({
        casesFile: value('--cases') || fileURLToPath(new URL('dev/cases.json', evalDir)),
        corpusDir: value('--corpus') || fileURLToPath(new URL('corpus/', evalDir)),
      })
    );
  } catch {
    throw error('E_EVAL_FAILED', 'Evaluation could not complete.');
  }
  return;
}

export async function hookOrMcp({ command, args, env, paths, output }) {
  /** @type {any} */
  let component;
  try {
    component = command === 'hook' ? await import('@brainatlas/hooks') : await import('@brainatlas/mcp');
  } catch (e) {
    if (e.code === 'ERR_MODULE_NOT_FOUND') throw error('E_COMPONENT_MISSING', 'Requested component is unavailable.');
    throw e;
  }
  const entry = command === 'hook' ? component.runHook : component.main;
  if (typeof entry !== 'function')
    throw error('E_COMPONENT_MISSING', 'Requested component entry point is unavailable.');
  try {
    if (command === 'mcp') await entry();
    else {
      const client = args[0];
      const event = args[1];
      if (
        args.length !== 2 ||
        !['claude', 'codex', 'kiro', 'copilot', 'gemini'].includes(client) ||
        !['prompt', 'session-start', 'session-end'].includes(event)
      )
        throw error('E_ARGUMENT', 'Hook client and event are required.');
      let stdin = '';
      for await (const chunk of process.stdin) {
        stdin += chunk;
        if (stdin.length > 1024 * 1024) throw error('E_HOOK_INPUT', 'Hook input is too large.');
      }
      const cfg = await loadConfig({ paths, env });
      cfg.stateDir = join(paths.stateDir, vaultId(cfg.vault.path));
      const roots = managedRoots(paths, env);
      const created = await missingDirectories(cfg.stateDir, env.HOME, roots);
      await mkdir(cfg.stateDir, { recursive: true });
      if (created.length) await recordCreatedDirectories(paths, created, env.HOME, roots);
      let result;
      if (event === 'session-end') {
        let hookInput = {};
        try {
          const parsed = stdin.trim() ? JSON.parse(stdin) : {};
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) hookInput = parsed;
        } catch {
          /* The hook component handles malformed payloads fail-open. */
        }
        const queued = await queueSessionEndReceipt({ client, hookInput, config: cfg, paths, env });
        result = queued
          ? await entry({ client, event, stdin, env, now: new Date(), config: cfg })
          : { stdout: '', exitCode: 0 };
      } else result = await entry({ client, event, stdin, env, now: new Date(), config: cfg });
      if (result.stdout) process.stdout.write(result.stdout);
      process.exitCode = result.exitCode;
    }
  } catch (e) {
    if (e.code === 'E_NOT_IMPLEMENTED') throw error('E_COMPONENT_MISSING', 'Requested component is unavailable.');
    throw e;
  }
  return;
}
