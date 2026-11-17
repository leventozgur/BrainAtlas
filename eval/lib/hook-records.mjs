// SPDX-License-Identifier: MIT
import { percentile } from './metrics.mjs';
import { caseKind } from './case-schema.mjs';

const BLOCK_TITLE = / \(([^()\n]+\.md)(?:#[^()\n]*)?\)$/u;
const HEADING_LINE = /^#{1,3}[\t ]+(.+)$/u;
// BA-32: a progressive pointer line, `- Title › Heading [unverified] (path#anchor)`, names its page without the fragment.
const POINTER_HEADER = 'More matches (open with wiki_read_page path + anchor):';
const POINTER_LINE = /^- .* \(([^()\n]+\.md)(?:#[^()\n]*)?\)$/u;

/**
 * Extract injected corpus paths from hook additionalContext.
 * A block starts at the beginning of the context or after an empty line, and its
 * first line has the form `Title (relative/path.md)`; a progressive block title may
 * end in `(path.md#anchor)` and names the page without the fragment (BA-32).
 * Only paths present in the corpus are accepted, so snippet text cannot create false injections.
 * BA-32: the lines directly after the exact progressive header line are pointer lines; their
 * paths are appended after the block paths, without duplicates. Pointer-like lines anywhere
 * else are ignored.
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
    if (lines[i].startsWith('- ')) continue;
    const match = lines[i].match(BLOCK_TITLE);
    if (!match || !knownPaths.has(match[1]) || out.includes(match[1])) continue;
    out.push(match[1]);
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] !== POINTER_HEADER) continue;
    for (let j = i + 1; j < lines.length && lines[j].startsWith('- '); j++) {
      const match = lines[j].match(POINTER_LINE);
      if (match && knownPaths.has(match[1]) && !out.includes(match[1])) out.push(match[1]);
    }
  }
  return out;
}

/**
 * Heading of the injected block for `path`: the first snippet line of that block when it is a Markdown heading.
 * A block title may end in `(path#anchor)`; the block is found by the path without the fragment (BA-32).
 * Returns null when the block is absent or its excerpt starts with plain text (no section name in the output).
 * @param {string} context
 * @param {string} path
 * @returns {string|null}
 */
export function parseBlockHeading(context, path) {
  if (typeof context !== 'string' || !context) return null;
  const lines = context.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (i > 0 && lines[i - 1] !== '') continue;
    if (lines[i].startsWith('- ')) continue;
    const match = lines[i].match(BLOCK_TITLE);
    if (!match || match[1] !== path) continue;
    const heading = (lines[i + 1] ?? '').match(HEADING_LINE);
    return heading ? heading[1].trim() : null;
  }
  return null;
}

const ratio = (part, whole) => (whole ? part / whole : 0);
const hit = (r) => r.injected.some((p) => r.relevant.includes(p));
const falseRecord = (r) => r.abstain || caseKind(r) === 'operational';

/**
 * BA-31m top-1 rates. Only the first injected block (injection order) is considered.
 * top1RelevantRate: answerable cases whose first injected block is in `relevant` (no injection counts as a miss).
 * top1ExcludedRate: cases with a non-empty `excluded` list whose first injected block is in `excluded` (wrong project).
 * Both are 0 when their denominator is 0.
 * @param {Array<object>} items
 */
function top1Rates(items) {
  const answers = items.filter((r) => !r.abstain);
  const withExcluded = items.filter((r) => Array.isArray(r.excluded) && r.excluded.length > 0);
  return {
    top1RelevantRate: ratio(
      answers.filter((r) => r.injected.length > 0 && r.relevant.includes(r.injected[0])).length,
      answers.length
    ),
    top1ExcludedRate: ratio(
      withExcluded.filter((r) => r.injected.length > 0 && r.excluded.includes(r.injected[0])).length,
      withExcluded.length
    ),
  };
}

/**
 * Aggregate per-case hook records into the hook-eval metric shape.
 * Record: {category, abstain, relevant, injected, chars, durationMs} plus the optional BA-27 fields
 * {kind, meta (flags of the first five injected blocks), poisoned, sectionHit (true|false|null), sectionSource}.
 * Records without the optional fields are read with their defaults (kind knowledge, no meta, not poisoned).
 * @param {Array<object>} records
 */
export function summarizeHookRecords(records) {
  const n = records.length;
  const answerable = records.filter((r) => !r.abstain);
  const injectedTotal = records.reduce((sum, r) => sum + r.injected.length, 0);
  const injectedRelevant = records.reduce((sum, r) => sum + r.injected.filter((p) => r.relevant.includes(p)).length, 0);
  const categories = new Map();
  const kinds = new Map();
  for (const r of records) {
    if (!categories.has(r.category)) categories.set(r.category, []);
    categories.get(r.category).push(r);
    const kind = caseKind(r);
    if (!kinds.has(kind)) kinds.set(kind, []);
    kinds.get(kind).push(r);
  }
  // Per-group shape: byCategory keeps its historical four keys; byKind adds the false-injection rate of that kind.
  const summarizeGroup = (items, withFalse) => {
    const injected = items.reduce((sum, r) => sum + r.injected.length, 0);
    const relevantInjected = items.reduce((sum, r) => sum + r.injected.filter((p) => r.relevant.includes(p)).length, 0);
    const answers = items.filter((r) => !r.abstain);
    const falses = items.filter(falseRecord);
    const group = {
      n: items.length,
      injectionRate: ratio(items.filter((r) => r.injected.length).length, items.length),
      missRate: answers.length ? ratio(answers.filter((r) => !hit(r)).length, answers.length) : 0,
      precision: ratio(relevantInjected, injected),
    };
    if (withFalse) group.falseInjectionRate = ratio(falses.filter((r) => r.injected.length).length, falses.length);
    return group;
  };
  const byCategory = Object.fromEntries(
    [...categories.entries()]
      .sort(([a], [b]) => a.localeCompare(b, 'en'))
      .map(([category, items]) => [category, summarizeGroup(items, false)])
  );
  const byKind = Object.fromEntries(
    [...kinds.entries()]
      .sort(([a], [b]) => a.localeCompare(b, 'en'))
      .map(([kind, items]) => [kind, summarizeGroup(items, true)])
  );
  // BA-31m: project-awareness summary. Only cases that carry a cwd; the same group shape plus the top-1 rates.
  const withCwd = records.filter((r) => typeof r.cwd === 'string');
  const withCwdSummary = { ...summarizeGroup(withCwd, true), ...top1Rates(withCwd) };
  const chars = records.map((r) => r.chars);
  const durations = records.map((r) => r.durationMs);
  const hitCount = records.filter(hit).length;
  const top5 = records.flatMap((r) => (Array.isArray(r.meta) ? r.meta : []));
  const sectionCases = records.filter((r) => r.sectionHit === true || r.sectionHit === false);
  const charStats = {
    mean: n ? chars.reduce((sum, v) => sum + v, 0) / n : 0,
    p50: percentile(chars, 0.5),
    p95: percentile(chars, 0.95),
  };
  return {
    n,
    injectionRate: ratio(records.filter((r) => r.injected.length).length, n),
    injectionPrecision: ratio(injectedRelevant, injectedTotal),
    missRate: answerable.length ? ratio(answerable.filter((r) => !hit(r)).length, answerable.length) : 0,
    falseInjectionRate: ratio(
      records.filter(falseRecord).filter((r) => r.injected.length).length,
      records.filter(falseRecord).length
    ),
    chars: charStats,
    durationMs: { p50: percentile(durations, 0.5), p95: percentile(durations, 0.95) },
    byCategory,
    // BA-27 additions. Existing keys above keep their meaning.
    byKind,
    injectedChars: charStats,
    charsPerHit: ratio(
      chars.reduce((sum, v) => sum + v, 0),
      hitCount
    ),
    neededPageInjected: ratio(answerable.filter(hit).length, answerable.length),
    metaShareTop5: ratio(top5.filter(Boolean).length, top5.length),
    sectionHitAt1: ratio(sectionCases.filter((r) => r.sectionHit === true).length, sectionCases.length),
    sectionCases: sectionCases.length,
    sectionHitSources: {
      hook: sectionCases.filter((r) => r.sectionSource === 'hook').length,
      search: sectionCases.filter((r) => r.sectionSource === 'search').length,
    },
    poisonInjected: ratio(records.filter((r) => r.poisoned === true).length, n),
    // BA-31m additions (existing keys above are unchanged).
    ...top1Rates(records),
    withCwd: withCwdSummary,
  };
}
