// SPDX-License-Identifier: MIT
// BA-48: the weekly read-only maintenance snapshot. No vault file is ever written here: the snapshot lives under the
// BrainAtlas state directory and every step only reads the Wiki. Running it on a schedule is left to the user's own
// scheduler (`brainatlas maintain --weekly` writes nothing into the vault).
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { vaultId } from '@brainatlas/core';
import { planCompaction } from './compact.mjs';
import { planFix } from './maintain-fix.mjs';
import { receiptCandidates, runMaintenance } from './maintain.mjs';
import { proposeCurrentState, synthesisSettings } from './synthesis/propose.mjs';

/** Snapshots kept per vault; older `weekly-YYYY-MM-DD.json` files are deleted. */
export const WEEKLY_KEEP = 12;
/** A weekly run older than this many days is overdue. */
export const WEEKLY_OVERDUE_MS = 8 * 24 * 60 * 60 * 1000;

const WEEKLY_FILE = /^weekly-\d{4}-\d{2}-\d{2}\.json$/u;
const CANDIDATE_SOURCES = 20;

const failure = (code, message) => Object.assign(new Error(message), { code });

async function readJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
}

/** `{ ranAt }` of the last weekly run in one directory, or null when it is missing or unreadable. */
async function readLastWeekly(directory) {
  const value = await readJson(join(directory, 'last-weekly.json'));
  return value && typeof value.ranAt === 'string' ? value : null;
}

const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T/u;

/** Epoch milliseconds of a recorded run, or null when `ranAt` is not an ISO date-time that `Date.parse` accepts. */
function runTime(ranAt) {
  if (typeof ranAt !== 'string' || !ISO_DATE_TIME.test(ranAt)) return null;
  const time = Date.parse(ranAt);
  return Number.isNaN(time) ? null : time;
}

const isOverdue = (ranAt, now) => {
  const time = runTime(ranAt);
  return time !== null && now.getTime() - time > WEEKLY_OVERDUE_MS;
};

/** `<stateDir>/<vaultId>/maintenance`, where the weekly snapshots live. */
export function weeklyDirectory(paths, vaultPath) {
  return join(paths.stateDir, vaultId(resolve(vaultPath)), 'maintenance');
}

/**
 * The overdue reminder for plain `maintain`: only when `last-weekly.json` exists for the vault and its `ranAt` is more
 * than 8 days old. Every read error is swallowed; this check never starts a process and never writes.
 */
export async function weeklyReminder(options = /** @type {any} */ ({})) {
  const { paths, vaultPath, now = new Date() } = options;
  try {
    const last = await readLastWeekly(weeklyDirectory(paths, vaultPath));
    if (!last || !isOverdue(last.ranAt, now)) return null;
    const lastRun = new Date(/** @type {number} */ (runTime(last.ranAt))).toISOString();
    return {
      lastRun,
      overdue: true,
      line: `Reminder: weekly maintenance has not run since ${lastRun.slice(0, 10)}; run "brainatlas maintain --weekly".`
    };
  } catch { return null; }
}

/** Review candidates for the receipts queue: report findings first, then the fix plan and the compaction pages. */
export function weeklyCandidates(report, fix, compact) {
  const candidates = receiptCandidates(report.findings);
  const changes = Array.isArray(fix?.changes) ? fix.changes : [];
  if (changes.length) {
    candidates.push({
      title: `Maintenance fix plan: ${changes.length} change(s)`,
      summary: `${changes.length} mechanical repair(s) planned by brainatlas maintain --fix; only the changed file paths are listed.`,
      sources: [...new Set(changes.map(change => change.path))].slice(0, CANDIDATE_SOURCES)
    });
  }
  const pages = compact.filter(item => !item.error && item.moved > 0).map(item => item.page);
  if (pages.length) {
    candidates.push({
      title: `Compaction candidates: ${pages.length} page(s)`,
      summary: `${pages.length} oversized page(s) have dated sections older than the newest 3; only the page paths are listed.`,
      sources: pages.slice(0, CANDIDATE_SOURCES)
    });
  }
  return candidates;
}

const formatWeekly = (snapshot, findings, compactionCandidates, queue) => {
  const lines = [`BrainAtlas weekly maintenance: ${findings} finding(s), ${snapshot.fix.changes} fix change(s) planned, ${compactionCandidates} compaction candidate(s); nothing was applied.`];
  lines.push(queue.queued ? `Queued ${queue.candidates ?? 0} review candidate(s) for receipts review.` : `Nothing queued (${queue.reason}).`);
  return lines.join('\n');
};

/** Write the snapshot, then `last-weekly.json`, then drop the oldest snapshots beyond WEEKLY_KEEP. */
async function writeWeeklyState(directory, snapshot) {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `weekly-${snapshot.ranAt.slice(0, 10)}.json`), `${JSON.stringify(snapshot, null, 2)}\n`);
  await writeFile(join(directory, 'last-weekly.json'), `${JSON.stringify({ ranAt: snapshot.ranAt }, null, 2)}\n`);
  const names = (await readdir(directory).catch(() => [])).filter(name => WEEKLY_FILE.test(name)).sort();
  for (const name of names.slice(0, Math.max(0, names.length - WEEKLY_KEEP))) await rm(join(directory, name), { force: true });
}

/**
 * One read-only weekly run: the maintenance report, the fix plan and a compaction plan per oversized page. `queue` is
 * the receipts hook of the CLI, or null when the vault is not the configured vault. A queue failure never fails the run.
 * In `maintain.synthesis.mode` `shadow` or `on` the external model step runs last; its errors are recorded, never thrown.
 * `configuredVault: false` (a `--vault` outside the configured vault) records `not-configured-vault` instead of calling it.
 * @param {string} vault @param {{paths:any,env:any,queue?:(candidates:any[])=>Promise<any>,now?:Date,config?:any,runCommand?:Function,dependencies?:{runCommand?:Function},configuredVault?:boolean}} options
 */
export async function runWeeklyMaintenance(vault, options = /** @type {any} */ ({})) {
  const { paths, queue = null, now = new Date(), config = null } = options;
  const runCommand = options.runCommand ?? options.dependencies?.runCommand;
  if (typeof vault !== 'string' || !vault) throw failure('E_VAULT_MISSING', 'Vault is missing or not a directory.');
  const report = await runMaintenance(vault, { now });
  const fix = await planFix(vault, { sources: false, now });
  const compact = [];
  const oversized = [...new Set(report.findings.filter(item => item.kind === 'oversized').map(item => item.path))];
  for (const page of oversized) {
    try {
      const planned = await planCompaction(vault, { page, keep: 3, now });
      compact.push({ page, moved: planned.moved.length });
    } catch (cause) {
      compact.push({ page, error: typeof cause?.code === 'string' ? cause.code : 'E_COMPACTION' });
    }
  }
  let synthesis = null;
  if (['shadow', 'on'].includes(synthesisSettings(config).mode)) {
    if (options.configuredVault === false) synthesis = { ran: false, reason: 'not-configured-vault' };
    else {
      try {
        synthesis = await proposeCurrentState({
          vault, config, stateDir: join(paths.stateDir, vaultId(resolve(vault))), now, runCommand, env: options.env
        });
      } catch (cause) {
        synthesis = { ran: false, reason: 'error', code: typeof cause?.code === 'string' ? cause.code : 'E_SYNTHESIS' };
      }
    }
  }
  const candidates = weeklyCandidates(report, fix, compact);
  const proposals = synthesis?.ran && Array.isArray(synthesis.proposals) ? synthesis.proposals : [];
  const openProposals = proposals.filter(item => item?.status === 'open');
  if (openProposals.length) {
    candidates.push({
      title: `Current-state proposals: ${openProposals.length} page(s)`,
      summary: `${openProposals.length} open current-state proposal(s) from the external model are waiting for review; nothing was written to the vault.`,
      sources: openProposals.map(item => item.page).slice(0, CANDIDATE_SOURCES)
    });
  }
  const compactionCandidates = compact.filter(item => !item.error && item.moved > 0).length;
  let queued;
  if (queue === null) queued = { queued: false, reason: 'not-configured-vault' };
  else if (!candidates.length) queued = { queued: false, reason: 'no-findings' };
  else {
    try { queued = await queue(candidates); }
    catch { queued = { queued: false, reason: 'queue-failed' }; }
  }
  const ranAt = now.toISOString();
  const snapshot = {
    ranAt,
    pages: report.pages,
    counts: report.counts,
    fix: { changes: fix.changes.length, counts: fix.counts, unfixed: fix.unfixed.length },
    compact,
    queue: queued,
    ...(synthesis ? { synthesis } : {})
  };
  await writeWeeklyState(weeklyDirectory(paths, vault), snapshot);
  return { snapshot, text: formatWeekly(snapshot, report.findings.length, compactionCandidates, queued) };
}
