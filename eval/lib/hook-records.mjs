// SPDX-License-Identifier: MIT
import { percentile } from './metrics.mjs';

/**
 * Extract injected corpus paths from hook additionalContext.
 * A block starts at the beginning of the context or after an empty line, and its
 * first line has the form `Title (relative/path.md)`. Only paths present in the
 * corpus are accepted, so snippet text cannot create false injections.
 * @param {string} context
 * @param {Set<string>} knownPaths
 * @returns {string[]} unique paths in injection order
 */
export function parseInjectedPaths(context, knownPaths) {
  if (typeof context !== 'string' || !context) return [];
  const lines = context.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (i > 0 && lines[i - 1] !== '') continue;
    const match = lines[i].match(/ \(([^()\n]+\.md)\)$/u);
    if (!match || !knownPaths.has(match[1]) || out.includes(match[1])) continue;
    out.push(match[1]);
  }
  return out;
}

const ratio = (part, whole) => (whole ? part / whole : 0);

/**
 * Aggregate per-case hook records into the hook-eval metric shape.
 * Record: {category, abstain, relevant, injected, chars, durationMs}.
 * @param {Array<{category:string,abstain:boolean,relevant:string[],injected:string[],chars:number,durationMs:number}>} records
 */
export function summarizeHookRecords(records) {
  const n = records.length;
  const answerable = records.filter((r) => !r.abstain);
  const abstaining = records.filter((r) => r.abstain);
  const injectedTotal = records.reduce((sum, r) => sum + r.injected.length, 0);
  const injectedRelevant = records.reduce((sum, r) => sum + r.injected.filter((p) => r.relevant.includes(p)).length, 0);
  const hit = (r) => r.injected.some((p) => r.relevant.includes(p));
  const categories = new Map();
  for (const r of records) {
    if (!categories.has(r.category)) categories.set(r.category, []);
    categories.get(r.category).push(r);
  }
  const byCategory = Object.fromEntries([...categories.entries()].sort(([a], [b]) => a.localeCompare(b, 'en')).map(([category, items]) => {
    const injected = items.reduce((sum, r) => sum + r.injected.length, 0);
    const relevantInjected = items.reduce((sum, r) => sum + r.injected.filter((p) => r.relevant.includes(p)).length, 0);
    const answers = items.filter((r) => !r.abstain);
    return [category, {
      n: items.length,
      injectionRate: ratio(items.filter((r) => r.injected.length).length, items.length),
      missRate: answers.length ? ratio(answers.filter((r) => !hit(r)).length, answers.length) : 0,
      precision: ratio(relevantInjected, injected),
    }];
  }));
  const chars = records.map((r) => r.chars);
  const durations = records.map((r) => r.durationMs);
  return {
    n,
    injectionRate: ratio(records.filter((r) => r.injected.length).length, n),
    injectionPrecision: ratio(injectedRelevant, injectedTotal),
    missRate: answerable.length ? ratio(answerable.filter((r) => !hit(r)).length, answerable.length) : 0,
    falseInjectionRate: ratio(abstaining.filter((r) => r.injected.length).length, abstaining.length),
    chars: {mean: n ? chars.reduce((sum, v) => sum + v, 0) / n : 0, p50: percentile(chars, 0.5), p95: percentile(chars, 0.95)},
    durationMs: {p50: percentile(durations, 0.5), p95: percentile(durations, 0.95)},
    byCategory,
  };
}
