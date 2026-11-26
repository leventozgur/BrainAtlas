// SPDX-License-Identifier: MIT
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const DAY_MS = 24 * 60 * 60 * 1000;
const VERDICTS = new Set(['useful', 'not-useful']);
const argumentError = (message) => Object.assign(new Error(message), { code: 'E_ARGUMENT' });
const owned = (st) => typeof process.getuid !== 'function' || st.uid === process.getuid();
// The same guarantees the hook's metric writer gives hooks.jsonl: the directory is a real directory owned by us, and the file
// is opened without following links, is a single regular file owned by us with no group/other bits.
async function secureDirectory(dir, recursive = false) {
  try {
    await mkdir(dir, { recursive, mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const st = await lstat(dir);
  if (!st.isDirectory() || st.isSymbolicLink() || !owned(st)) throw argumentError('Metrics directory is unsafe.');
}
async function secureFile(file, flags) {
  let handle;
  try {
    handle = await open(file, flags | (constants.O_NOFOLLOW || 0), 0o600);
  } catch (error) {
    throw argumentError(`Feedback file cannot be opened (${error.code ?? 'error'}).`);
  }
  try {
    const st = await handle.stat();
    if (!st.isFile() || st.nlink !== 1 || !owned(st) || st.mode & 0o077)
      throw argumentError('Feedback file is unsafe.');
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** True for the two words the feedback command accepts. */
export function isFeedbackVerdict(value) {
  return VERDICTS.has(value);
}

/** Reads JSON objects from a JSONL file; a missing file and non-object lines are skipped. */
export async function readJsonl(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const records = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) records.push(value);
  }
  return records;
}

function inWindow(record, from, to) {
  const time = typeof record.ts === 'string' || typeof record.ts === 'number' ? new Date(record.ts).getTime() : NaN;
  return Number.isFinite(time) && time >= from && time <= to;
}
const numeric = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const mean = (values) => (values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0);
// Nearest-rank percentile: rank = ceil(p/100 * n), clamped to a real element.
function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(sorted.length, rank) - 1];
}

/** Aggregates hook and feedback metrics for the last `days` days. Content-free by construction. @param {{stateDir?:string,days?:number,now?:Date}} [options] */
export async function usageSummary({ stateDir, days = 7, now = new Date() } = {}) {
  if (!Number.isInteger(days) || days < 1) throw argumentError('Usage days must be an integer of at least 1.');
  const dir = join(stateDir, 'metrics');
  const [hooks, feedbackRecords] = await Promise.all([
    readJsonl(join(dir, 'hooks.jsonl')),
    readJsonl(join(dir, 'feedback.jsonl')),
  ]);
  const to = now.getTime();
  const from = to - days * DAY_MS;
  const prompts = hooks.filter((record) => record.event === 'prompt' && inWindow(record, from, to));
  const outcomes = { ok: 0, empty: 0, deadline: 0, error: 0 };
  for (const record of prompts) if (Object.hasOwn(outcomes, record.outcome)) outcomes[record.outcome]++;
  const results = prompts.map((record) => numeric(record.results));
  const chars = prompts.map((record) => numeric(record.chars));
  const durations = prompts
    .map((record) => record.durationMs)
    .filter((value) => typeof value === 'number' && Number.isFinite(value));
  const shadows = prompts
    .filter((record) => record.shadow && typeof record.shadow === 'object' && !Array.isArray(record.shadow))
    .map((record) => record.shadow);
  const feedback = { useful: 0, notUseful: 0 };
  for (const record of feedbackRecords) {
    if (!inWindow(record, from, to)) continue;
    if (record.verdict === 'useful') feedback.useful++;
    else if (record.verdict === 'not-useful') feedback.notUseful++;
  }
  const events = { prompt: 0, 'session-start': 0 };
  const byClient = {};
  for (const record of hooks) {
    if (!inWindow(record, from, to)) continue;
    if (record.event !== 'prompt' && record.event !== 'session-start') continue;
    events[record.event]++;
    if (typeof record.client !== 'string') continue;
    const entry = (byClient[record.client] ??= { prompt: 0, 'session-start': 0, lastAt: null });
    entry[record.event]++;
    const time = new Date(record.ts).getTime();
    if (entry.lastAt === null || time > Date.parse(entry.lastAt)) entry.lastAt = new Date(time).toISOString();
  }
  return {
    days,
    stateDir,
    prompts: prompts.length,
    events,
    byClient,
    outcomes,
    injectionRate: prompts.length ? results.filter((value) => value > 0).length / prompts.length : 0,
    meanResults: mean(results),
    durationMs: { p50: percentile(durations, 50), p95: percentile(durations, 95) },
    meanChars: mean(chars),
    shadow: {
      n: shadows.length,
      top1SameRate: shadows.length ? shadows.filter((value) => value.top1Same === true).length / shadows.length : 0,
      meanOverlap5: mean(shadows.map((value) => numeric(value.overlap5))),
      injectDiffRate: shadows.length ? shadows.filter((value) => value.injectDiff === true).length / shadows.length : 0,
    },
    feedback,
  };
}

/** Human-readable form of a summary; it repeats only the aggregates. */
export function formatUsage(summary) {
  const { days, prompts, outcomes, injectionRate, meanResults, durationMs, meanChars, shadow, feedback } = summary;
  const events = summary.events ?? { prompt: 0, 'session-start': 0 };
  const byClient = summary.byClient ?? {};
  return [
    `BrainAtlas usage (last ${days} days)`,
    `Prompts: ${prompts}`,
    `Events: prompt ${events.prompt}, session-start ${events['session-start']}`,
    ...Object.keys(byClient)
      .sort()
      .map(
        (client) =>
          `  ${client}: prompt ${byClient[client].prompt}, session-start ${byClient[client]['session-start']}, last ${byClient[client].lastAt ?? 'never'}`
      ),
    `Outcomes: ok ${outcomes.ok}, empty ${outcomes.empty}, deadline ${outcomes.deadline}, error ${outcomes.error}`,
    `Injection rate: ${injectionRate}`,
    `Mean results: ${meanResults}`,
    `Duration ms: p50 ${durationMs.p50}, p95 ${durationMs.p95}`,
    `Mean chars: ${meanChars}`,
    `Shadow: n ${shadow.n}, top1Same ${shadow.top1SameRate}, meanOverlap5 ${shadow.meanOverlap5}, injectDiff ${shadow.injectDiffRate}`,
    `Feedback: useful ${feedback.useful}, not-useful ${feedback.notUseful}`,
    `Metrics: ${summary.stateDir}/metrics/hooks.jsonl`,
  ].join('\n');
}

/** Appends one one-word feedback record with the hooks.jsonl permissions (file 0600, directory 0700). @param {{stateDir?:string,verdict?:string,now?:Date}} [options] */
export async function recordFeedback({ stateDir, verdict, now = new Date() } = {}) {
  if (!isFeedbackVerdict(verdict)) throw argumentError('Feedback verdict must be useful or not-useful.');
  await secureDirectory(stateDir, true);
  const dir = join(stateDir, 'metrics');
  await secureDirectory(dir);
  const handle = await secureFile(
    join(dir, 'feedback.jsonl'),
    constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND
  );
  try {
    await handle.writeFile(`${JSON.stringify({ ts: now.toISOString(), verdict })}\n`);
  } finally {
    await handle.close();
  }
  return { recorded: true, verdict };
}
