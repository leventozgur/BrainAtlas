// SPDX-License-Identifier: MIT
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OPS = new Set(['>=', '<=', '==']);
const EPSILON = 1e-12;

/** Read a dotted metric path; returns undefined for any missing or non-own segment. */
export function getMetric(object, path) {
  let cursor = object;
  for (const key of path.split('.')) {
    if (cursor === null || typeof cursor !== 'object' || !Object.hasOwn(cursor, key)) return undefined;
    cursor = cursor[key];
  }
  return cursor;
}

function validateCriterion(item, group) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid criteria');
  if (typeof item.metric !== 'string' || !item.metric || item.metric.split('.').some((part) => !part)) throw new Error('Invalid criteria');
  if (!OPS.has(item.op)) throw new Error('Invalid criteria');
  const hasDelta = item.delta !== undefined;
  const hasValue = item.value !== undefined;
  if (hasDelta === hasValue) throw new Error('Invalid criteria');
  if (hasDelta && !Number.isFinite(item.delta)) throw new Error('Invalid criteria');
  if (hasValue && !Number.isFinite(item.value)) throw new Error('Invalid criteria');
  return {group, metric: item.metric, op: item.op, delta: hasDelta ? item.delta : undefined, value: hasValue ? item.value : undefined};
}

/** Validate a criteria document: at least one primary criterion; guards are optional. */
export function parseCriteria(criteria) {
  if (!criteria || typeof criteria !== 'object' || Array.isArray(criteria)) throw new Error('Invalid criteria');
  if (!Array.isArray(criteria.primary) || criteria.primary.length === 0) throw new Error('Invalid criteria');
  if (criteria.guards !== undefined && !Array.isArray(criteria.guards)) throw new Error('Invalid criteria');
  return [
    ...criteria.primary.map((item) => validateCriterion(item, 'primary')),
    ...(criteria.guards ?? []).map((item) => validateCriterion(item, 'guard')),
  ];
}

/**
 * Decide KEEP or DISCARD for a candidate against a baseline.
 * A criterion with a missing or non-numeric metric in either document fails; it never passes silently.
 * @param {{baseline:object,candidate:object,criteria:object}} input
 */
export function evaluateGate({baseline, candidate, criteria}) {
  const parsed = parseCriteria(criteria);
  const results = parsed.map((item) => {
    const base = getMetric(baseline, item.metric);
    const cand = getMetric(candidate, item.metric);
    const hasBase = typeof base === 'number' && Number.isFinite(base);
    const hasCand = typeof cand === 'number' && Number.isFinite(cand);
    let threshold = null;
    if (item.delta !== undefined && hasBase) threshold = base + item.delta;
    if (item.value !== undefined) threshold = item.value;
    let pass = false;
    if (hasBase && hasCand && threshold !== null) {
      if (item.op === '>=') pass = cand >= threshold - EPSILON;
      else if (item.op === '<=') pass = cand <= threshold + EPSILON;
      else pass = Math.abs(cand - threshold) <= EPSILON;
    }
    return {
      group: item.group,
      metric: item.metric,
      op: item.op,
      baseline: hasBase ? base : null,
      candidate: hasCand ? cand : null,
      threshold,
      result: pass ? 'PASS' : 'FAIL',
    };
  });
  const decision = results.every((item) => item.result === 'PASS') ? 'KEEP' : 'DISCARD';
  return {decision, criteria: results};
}

function parseArgs(args) {
  const options = {json: false};
  const valueFlags = new Set(['--baseline', '--candidate', '--criteria']);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') { options.json = true; continue; }
    if (!valueFlags.has(args[i]) || i + 1 >= args.length || args[i + 1].startsWith('--')) throw new Error('Invalid arguments');
    options[args[i].slice(2)] = args[++i];
  }
  if (!options.baseline || !options.candidate || !options.criteria) throw new Error('Invalid arguments');
  return options;
}

const readJson = (file) => {
  const value = JSON.parse(readFileSync(file, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid input');
  return value;
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let outcome;
  try {
    const args = parseArgs(process.argv.slice(2));
    outcome = evaluateGate({
      baseline: readJson(args.baseline),
      candidate: readJson(args.candidate),
      criteria: readJson(args.criteria),
    });
  } catch {
    console.error('Invalid input');
    process.exitCode = 2;
  }
  if (outcome) {
    const json = process.argv.includes('--json');
    if (json) console.log(JSON.stringify(outcome));
    else {
      for (const item of outcome.criteria) {
        console.log(`${item.result} ${item.group} ${item.metric} ${item.op} threshold=${item.threshold} baseline=${item.baseline} candidate=${item.candidate}`);
      }
      console.log(`decision: ${outcome.decision}`);
    }
    process.exitCode = outcome.decision === 'KEEP' ? 0 : 1;
  }
}
