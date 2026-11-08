// SPDX-License-Identifier: MIT
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { checkVault as coreCheckVault } from '../../../packages/core/src/okf/index.mjs';
import { resolveSafePath } from '../../../packages/core/src/util/index.mjs';
import { parseFrontmatter } from '../../../packages/core/src/vault/index.mjs';

const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const dateOnly = /^\d{4}-\d{2}-\d{2}$/;
const STRUCTURAL_PAGES = new Set(['wiki/index.md', 'wiki/log.md']);
const finding = (path, rule, message) => ({ path, rule, severity: 'error', message });
const validDate = (value) => typeof value === 'string' && (dateOnly.test(value) || timestamp.test(value)) && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString().slice(0, 10) === value.slice(0, 10);
const validTimestamp = (value) => typeof value === 'string' && timestamp.test(value) && validDate(value);
const validWikiPath = (value) => typeof value === 'string' && value.startsWith('wiki/') && value.endsWith('.md') && !value.includes('\\') && value.split('/').every((part) => part && part !== '.' && part !== '..');

async function readWikiPages(vaultDir) {
  const base = resolve(vaultDir);
  const pages = new Map();
  async function visit(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile() && entry.name.endsWith('.md')) {
        const path = file.slice(base.length + 1).split(/[\\/]/g).join('/');
        try {
          const stat = await lstat(file);
          if (!stat.isFile() || stat.isSymbolicLink()) continue;
          pages.set(path, parseFrontmatter(await readFile(file, 'utf8')).data);
        } catch { /* core checkVault reports unreadable pages without exposing their contents */ }
      }
    }
  }
  try { await visit(join(base, 'wiki')); } catch (cause) { if (cause?.code !== 'ENOENT') throw cause; }
  return pages;
}

function strictPageFindings(path, data, pages) {
  if (STRUCTURAL_PAGES.has(path)) return [];
  const result = [];
  if (data.status === 'confirmed') {
    const records = Array.isArray(data.verified) ? data.verified : [];
    const hasScopedEvidence = records.some((record) => record && typeof record === 'object' && !Array.isArray(record)
      && validDate(record.date) && ['evidence', 'scope', 'source'].every((key) => typeof record[key] === 'string' && record[key].trim())
      && Array.isArray(data.sources) && data.sources.includes(record.source));
    if (!hasScopedEvidence) result.push(finding(path, 'confirmed.unverified', 'Confirmed pages need a scoped verification record linked to a listed source.'));
  }
  if (!validTimestamp(data.generated)) result.push(finding(path, 'generated.timestamp-required', 'generated must be a UTC timestamp.'));
  if (data.stale_after !== undefined && !(validDate(data.stale_after) || (typeof data.stale_after === 'string' && /^P[1-9]\d*[DW]$/.test(data.stale_after)))) {
    result.push(finding(path, 'stale_after.invalid', 'stale_after must be a UTC date, timestamp, or positive P<n>D/P<n>W duration.'));
  }
  if (data.status === 'superseded') {
    const target = data.superseded_by;
    const targetData = validWikiPath(target) ? pages.get(target) : undefined;
    if (!targetData || targetData.status === 'superseded') result.push(finding(path, 'superseded.target-invalid', 'superseded_by must point to an existing page that is not superseded.'));
  }
  return result;
}

/** Run the local OKF checks, applying the stricter evidence and supersession gates. */
export async function check(vaultDir, options = {}) {
  const selected = options.changed === undefined ? null : [...new Set(options.changed)];
  const asOf = options.asOf === undefined ? new Date() : options.asOf;
  if (asOf instanceof Date ? !Number.isFinite(asOf.getTime()) : (typeof asOf !== 'string' || !validDate(asOf))) throw new TypeError('asOf must be a valid UTC date or timestamp.');
  if (selected !== null) await Promise.all(selected.map((path) => resolveSafePath(vaultDir, path)));
  const core = options.core ?? {};
  const checkVault = typeof core.checkVault === 'function' ? core.checkVault : coreCheckVault;
  const findings = await checkVault(vaultDir, { ...(options.asOf === undefined ? {} : { asOf }), ...(selected === null ? {} : { changed: selected }) });
  const pages = await readWikiPages(vaultDir);
  const wanted = selected === null ? null : new Set(selected);
  const strictFindings = [];
  for (const [path, data] of pages) {
    if (wanted && !wanted.has(path)) continue;
    if (options.strict !== false) strictFindings.push(...strictPageFindings(path, data, pages));
  }
  const merged = new Map();
  for (const item of [...findings, ...strictFindings]) {
    const strictRule = item.rule === 'confirmed.unverified' || item.rule === 'stale_after.invalid' || item.rule === 'generated.timestamp-required' || item.rule === 'superseded.target-invalid' || item.rule === 'superseded.target-missing';
    const normalized = { ...item, severity: strictRule ? 'error' : item.severity };
    const key = `${normalized.path}\0${normalized.rule}`;
    if (!merged.has(key) || normalized.severity === 'error') merged.set(key, normalized);
  }
  return [...merged.values()].sort((a, b) => a.path.localeCompare(b.path) || a.rule.localeCompare(b.rule));
}

/** Checkpoint-compatible injected lint callback. */
export async function lintGate(vaultDir, changedPaths, options = {}) {
  const findings = await check(vaultDir, { ...options, ...(changedPaths === undefined ? {} : { changed: changedPaths }) });
  const errors = findings.filter((item) => item.severity === 'error').length;
  return { ok: errors === 0, findings, errorCount: errors, warningCount: findings.length - errors };
}

function parseArgs(args) {
  if (!Array.isArray(args)) throw new TypeError('Command arguments must be an array.');
  const options = { strict: false, json: false, changed: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--strict') options.strict = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--changed') {
      let count = 0;
      while (i + 1 < args.length && !args[i + 1].startsWith('--')) {
        const path = args[++i];
        if (!validWikiPath(path)) throw new TypeError('--changed requires relative wiki/*.md paths.');
        options.changed.push(path);
        count++;
      }
      if (!count) throw new TypeError('--changed requires at least one relative wiki/*.md path.');
    } else if (arg === '--as-of') {
      const date = args[++i];
      if (typeof date !== 'string' || !dateOnly.test(date) || !validDate(date)) throw new TypeError('--as-of must use YYYY-MM-DD.');
      options.asOf = new Date(`${date}T23:59:59.999Z`);
    } else throw new TypeError('Unknown OKF check option.');
  }
  if (!options.changed.length) delete options.changed;
  return options;
}

/** Module command entry: commands.check({vaultDir, core}, ['--strict', ...]). */
export async function checkCommand(ctx, args = []) {
  if (typeof ctx?.vaultDir !== 'string' || !ctx.vaultDir) throw new TypeError('OKF command needs a vaultDir.');
  const options = parseArgs(args);
  let findings;
  try {
    findings = await check(ctx.vaultDir, { ...options, core: ctx.core });
  } catch (cause) {
    if (cause?.code !== 'E_PATH_ESCAPE') throw cause;
    return { ok: false, findings: [], errorCode: 'E_PATH_ESCAPE', exitCode: 1, json: options.json };
  }
  const errorCount = findings.filter((item) => item.severity === 'error').length;
  return { ok: errorCount === 0, findings, errorCount, warningCount: findings.length - errorCount, exitCode: errorCount ? 1 : 0, json: options.json };
}

/** Generic CLI module command entry. Args may include the module's `check` verb. */
export async function okfCommand(args, ctx) {
  if (!Array.isArray(args)) throw new TypeError('Command arguments must be an array.');
  const checkArgs = args[0] === 'check' ? args.slice(1) : args;
  const result = await checkCommand(ctx, checkArgs);
  const output = result.json
    ? JSON.stringify({ findings: result.findings, ...(result.errorCode ? { errorCode: result.errorCode } : {}) })
    : result.findings.map((item) => `${item.severity}: ${item.path} ${item.rule} — ${item.message}`).join('\n');
  return { exitCode: result.exitCode, output };
}

export async function activate(ctx) {
  if (!ctx || typeof ctx !== 'object') throw new TypeError('Module activation context is required.');
}

export const commands = Object.freeze({ check: checkCommand, okf: okfCommand });
