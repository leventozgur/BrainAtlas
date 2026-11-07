// SPDX-License-Identifier: MIT
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseFrontmatter } from '../vault/index.mjs';

export const PROFILE = 'brainatlas-okf-local-v1';
const statuses = new Set(['proposed', 'confirmed', 'superseded', 'disputed']);
const types = new Set(['entity', 'concept', 'source', 'summary', 'query']);
const dateOnly = /^\d{4}-\d{2}-\d{2}$/;
const utcTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const isDate = (v) => typeof v === 'string' && (dateOnly.test(v) || utcTime.test(v)) && Number.isFinite(Date.parse(v)) && new Date(Date.parse(v)).toISOString().slice(0, 10) === v.slice(0, 10);
const finding = (path, rule, severity, message) => ({ path, rule, severity, message });

/** Check a parsed page or {path,data,body} record. Messages never include body text. */
export function checkPage(page, options = {}) {
  const path = String(page?.path ?? 'wiki/unknown.md');
  const data = page?.data ?? page?.frontmatter ?? page ?? {};
  const findings = [];
  const add = (rule, severity, message) => findings.push(finding(path, rule, severity, message));
  if (path === 'wiki/index.md' || path === 'wiki/log.md') return findings;
  if (page?.errors?.length) add('frontmatter.invalid', 'error', 'Frontmatter could not be parsed.');
  const type = data.type;
  if (type !== undefined && !types.has(type)) add('type.invalid', 'error', 'Type is not a supported Wiki page type.');
  for (const key of ['generated', 'status', 'sources', 'verified', 'stale_after']) if (!Object.hasOwn(data, key)) add(`required.${key}`, 'warn', `Required field '${key}' is missing.`);
  if (data.status !== undefined && !statuses.has(data.status)) add('status.invalid', 'error', 'Status is not a supported value.');
  if (data.generated !== undefined && !isDate(data.generated)) add('generated.invalid', 'error', 'Generated must be a UTC date or timestamp string.');
  if (data.generated && isDate(data.generated) && Date.parse(data.generated) > (options.asOf ?? new Date())) add('generated.future', 'error', 'Generated is later than the as-of time.');
  if (data.sources !== undefined && (!Array.isArray(data.sources) || data.sources.some((s) => typeof s !== 'string' || !s.trim()))) add('sources.invalid', 'error', 'Sources must be a list of non-empty strings.');
  if (data.verified !== undefined && (!Array.isArray(data.verified) || data.verified.some((v) => !v || typeof v !== 'object' || Array.isArray(v) || !isDate(v.date) || !['evidence', 'scope', 'source'].every((k) => typeof v[k] === 'string' && v[k].trim())))) add('verified.invalid', 'error', 'Verified must be a list of dated evidence records.');
  if (Array.isArray(data.verified) && Array.isArray(data.sources) && data.verified.some((v) => v && typeof v === 'object' && typeof v.source === 'string' && !data.sources.includes(v.source))) add('verified.source-unlisted', 'warn', 'Each verification source should also appear in sources.');
  if (data.status === 'confirmed' && Array.isArray(data.verified) && data.verified.length === 0) add('confirmed.unverified', 'warn', 'Confirmed pages need at least one verified record.');
  const stale = data.stale_after;
  if (stale !== undefined && !(isDate(stale) || (typeof stale === 'string' && /^P[1-9]\d*[DW]$/.test(stale)))) add('stale_after.invalid', 'error', 'stale_after must be a UTC date, timestamp, or positive P<n>D/P<n>W duration.');
  if (stale !== undefined && (isDate(stale) || (typeof stale === 'string' && /^P[1-9]\d*[DW]$/.test(stale)))) {
    const asOf = options.asOf instanceof Date ? options.asOf : new Date(options.asOf ?? Date.now());
    const latest = Array.isArray(data.verified) ? data.verified.map((v) => v?.date).filter(isDate).sort().at(-1) : null;
    const origin = Date.parse(latest ?? data.generated ?? '');
    let expired = false;
    if (isDate(stale)) expired = asOf.getTime() > (dateOnly.test(stale) ? Date.parse(`${stale}T23:59:59.999Z`) : Date.parse(stale));
    else if (Number.isFinite(origin)) {
      const amount = Number(stale.match(/\d+/)[0]) * (stale.endsWith('W') ? 7 : 1);
      expired = asOf.getTime() > Date.parse(`${new Date(origin).toISOString().slice(0, 10)}T23:59:59.999Z`) + amount * 86400000;
    }
    if (expired) add('stale.expired', 'warn', 'Page has passed its review threshold.');
  }
  if (data.status === 'superseded') {
    if (typeof data.superseded_by !== 'string' || !data.superseded_by.startsWith('wiki/') || !data.superseded_by.endsWith('.md') || data.superseded_by.includes('..')) add('superseded.target-required', 'warn', 'Superseded pages need a valid wiki path in superseded_by.');
  } else if (data.superseded_by !== undefined) add('superseded.target-unexpected', 'warn', 'superseded_by is only used for superseded pages.');
  if (['entity', 'concept'].includes(type)) for (const key of ['aliases', 'keywords']) if (!Array.isArray(data[key])) add(`recommended.${key}`, 'warn', `Entity and concept pages should include a ${key} list.`);
  // The YAML parser returns date-only values as strings; explicitly flag unquoted source scalars
  // so a future parser change cannot silently turn them into timezone-shifted timestamps.
  const raw = typeof page?.raw === 'string' ? page.raw : '';
  for (const key of ['generated', 'stale_after']) if (new RegExp(`^${key}:\\s*\\d{4}-\\d{2}-\\d{2}(?:$|\\s+#)`, 'm').test(raw)) add(`date.unquoted.${key}`, 'warn', `Quote the ${key} date to preserve date-only semantics.`);
  if (/^\s*-\s+date:\s*\d{4}-\d{2}-\d{2}(?:$|\s+#)/m.test(raw)) add('date.unquoted.verified', 'warn', 'Quote verified dates to preserve date-only semantics.');
  return findings;
}

export async function checkVault(vaultDir, options = {}) {
  const base = resolve(vaultDir); const paths = [];
  const wanted = options.changed;
  async function visit(dir) {
    for (const ent of await readdir(dir, { withFileTypes: true })) {
      const file = join(dir, ent.name);
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) await visit(file);
      else if (ent.isFile() && ent.name.endsWith('.md')) paths.push(file.slice(base.length + 1).split(/[\\/]/g).join('/'));
    }
  }
  try { await visit(join(base, 'wiki')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const selected = wanted ? [...new Set(wanted)].filter((p) => typeof p === 'string' && p.startsWith('wiki/') && p.endsWith('.md') && !p.includes('\\') && p.split('/').every((part) => part && part !== '.' && part !== '..')).sort() : paths.sort();
  const all = [];
  for (const path of selected) {
    try {
      const file = join(base, path); const stat = await lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      const raw = await readFile(file, 'utf8');
      all.push(...checkPage({ path, ...parseFrontmatter(raw), raw }, options));
    } catch { all.push(finding(path, 'page.unreadable', 'error', 'Page is missing or unreadable.')); }
  }
  if (!wanted) {
    const existing = new Set(paths);
    for (const path of paths) {
      const parsed = parseFrontmatter(await readFile(join(base, path), 'utf8'));
      const target = parsed.data.superseded_by;
      if (parsed.data.status === 'superseded' && typeof target === 'string' && target.startsWith('wiki/') && !existing.has(target)) all.push(finding(path, 'superseded.target-missing', 'warn', 'The superseded_by target is not present in the Wiki scan.'));
    }
  }
  return all.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0));
}
