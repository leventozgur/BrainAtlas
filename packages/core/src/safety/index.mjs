// SPDX-License-Identifier: MIT
import { createHash } from 'node:crypto';
import { CONTENT_RULES, DENY_GLOBS, PERSONAL_RULES, CONTACT_RULES } from './rules.mjs';

const placeholder = /^(?:<[^>]*>|x{3,}|changeme|example|none|null|undefined|redacted|placeholder|\$\{[^}]+\}|\$[A-Za-z_][\w]*|process\.env\.[\w]+|\*+)$/i;
// BA-26: keys may contain Turkish letters; the lookbehind replaces \b, which does not treat them as word characters.
const assignment = /(?<![A-Za-z0-9_])([A-Za-z_\u00c7\u00e7\u011e\u011f\u0130\u0131\u00d6\u00f6\u015e\u015f\u00dc\u00fc][A-Za-z0-9_.\u00c7\u00e7\u011e\u011f\u0130\u0131\u00d6\u00f6\u015e\u015f\u00dc\u00fc-]{0,127})["']?[ \t]*[:=][ \t]*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|(\$\{[A-Za-z_][A-Za-z0-9_]*\}|[^\s,;"'\]}]+))/g;
const secretKey = /(?:password|passwd|passphrase|(?:^|[_ .-])pwd|secret|token|api[_ .-]?key|access[_ .-]?key|credential|private[_ .-]?key)|(?:^|[_ .-])(?:\u015fifre|sifre|parola)$/i;
const explicitKey = /(?:password|passwd|passphrase|(?:^|[_ .-])pwd|secret)|(?:^|[_ .-])(?:\u015fifre|sifre|parola)$/i;
// BA-26 fix1: keys are folded before matching: dotted capital İ and dotless ı both count as i, so ŞİFRE matches şifre.
const foldKey = key => key.replace(/[\u0130\u0131I]/g, 'i');
// BA-26 fix1: query-string and matrix parameters (?k=v&k2=v2, ;k=v, #k=v). After a URL scheme the general assignment pass consumes
// the rest of the URL as the value of the scheme, so these pairs get their own pass with anchored key rules: the last key segment
// must be a secret word, which keeps keys such as password_policy or token_count out of the findings.
const queryPair = /(?<=[?&;#])([A-Za-z_\u00c7\u00e7\u011e\u011f\u0130\u0131\u00d6\u00f6\u015e\u015f\u00dc\u00fc][A-Za-z0-9_.\u00c7\u00e7\u011e\u011f\u0130\u0131\u00d6\u00f6\u015e\u015f\u00dc\u00fc-]{0,127})=(\$\{[A-Za-z_][A-Za-z0-9_]*\}|[^\s&;#"'<>,\]}]+)/g;
const queryExplicit = /(?:^|[_.-])(?:password|passwd|passphrase|pwd|secret|\u015fifre|sifre|parola)$/i;
const queryGeneric = /(?:^|[_.-])(?:token|api[_.-]?key|access[_.-]?key|credential|private[_.-]?key)$/i;
const safeKey = /(?:^|[_ .-])(?:max|min|input|output|total|prompt|completion)[_ .-]?tokens?$|tokens?[_ .-]?(?:limit|count|budget|usage|max)$/i;
function highEntropy(value) {
  if (value.length < 16 || !/[a-z]/i.test(value) || !/[0-9]/.test(value)) return false;
  const counts = new Map();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) { const p = count / value.length; entropy -= p * Math.log2(p); }
  return entropy >= 3;
}
/** @param {string} text @param {{rules?:object[]}} options */
export function scanText(text, options = {}) {
  if (typeof text !== 'string') throw new TypeError('Expected text to be a string');
  const findings = [];
  const add = (ruleId, start, end, kind = 'content') => findings.push({ ruleId, kind, start, end });
  for (const rule of [...CONTENT_RULES, ...(options.rules ?? [])]) {
    if (!rule || typeof rule.id !== 'string' || !(rule.pattern instanceof RegExp)) throw new TypeError('Invalid safety rule');
    const flags = rule.pattern.flags.includes('g') ? rule.pattern.flags : rule.pattern.flags + 'g';
    const pattern = new RegExp(rule.pattern.source, flags);
    for (const match of text.matchAll(pattern)) {
      if (!match[0].length) continue;
      if (rule.id === 'connection-credentials') {
        const value = match[0].slice(match[0].indexOf(':', match[0].indexOf('://') + 3) + 1, -1);
        if (placeholder.test(value)) continue;
      }
      add(rule.id, match.index, match.index + match[0].length);
    }
  }
  // BA-26: personal-data findings are reported only when their checksum agrees; a failing candidate is not a finding.
  for (const rule of PERSONAL_RULES) {
    for (const match of text.matchAll(new RegExp(rule.pattern.source, rule.pattern.flags.includes('g') ? rule.pattern.flags : rule.pattern.flags + 'g'))) {
      if (rule.valid(match[0])) add(rule.id, match.index, match.index + match[0].length, 'personal');
    }
  }
  for (const match of text.matchAll(assignment)) {
    // Query-form keys (after ? & ; #) are handled by the query pass below, with its anchored key rules.
    const before = match.index > 0 ? text[match.index - 1] : '';
    if (before && '?&;#'.includes(before)) continue;
    const key = foldKey(match[1]), value = match[2] ?? match[3] ?? match[4];
    if (!secretKey.test(key) || safeKey.test(key) || !value || placeholder.test(value)) continue;
    if (!explicitKey.test(key) && !highEntropy(value)) continue;
    const start = match.index + match[0].lastIndexOf(value);
    add(/aws.*secret/i.test(key) ? 'aws-secret-key' : explicitKey.test(key) ? 'secret-assignment' : 'high-entropy-assignment', start, start + value.length);
  }
  for (const match of text.matchAll(queryPair)) {
    const key = foldKey(match[1]), value = match[2];
    if (safeKey.test(key) || placeholder.test(value)) continue;
    let ruleId;
    if (queryExplicit.test(key)) ruleId = 'secret-assignment';
    else if (queryGeneric.test(key) && highEntropy(value)) ruleId = 'high-entropy-assignment';
    else continue;
    const start = match.index + match[0].length - value.length;
    if (findings.some(f => f.ruleId === ruleId && f.start === start && f.end === start + value.length)) continue;
    add(ruleId, start, start + value.length);
  }
  const header = /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/g;
  for (const match of text.matchAll(header)) {
    const endMarker = match[0].replace('BEGIN', 'END');
    const end = text.indexOf(endMarker, match.index + match[0].length);
    add('private-key', match.index, end < 0 ? text.length : end + endMarker.length);
  }
  return sortFindings(findings);
}
function sortFindings(findings) {
  return findings.sort((a, b) => a.start - b.start || b.end - a.end || a.ruleId.localeCompare(b.ruleId));
}

// Segment matching avoids regular-expression backtracking for user-supplied globs.
function segmentMatch(pattern, value) {
  let p = 0, v = 0, star = -1, retry = 0;
  while (v < value.length) {
    if (p < pattern.length && (pattern[p] === '?' || pattern[p] === value[v])) { p++; v++; }
    else if (pattern[p] === '*') { star = p++; retry = v; }
    else if (star >= 0) { p = star + 1; v = ++retry; }
    else return false;
  }
  while (pattern[p] === '*') p++;
  return p === pattern.length;
}
function globMatch(glob, path) {
  const parts = glob.split('/').filter(Boolean), items = path.split('/').filter(Boolean);
  if (parts.length === 1) return items.some((item) => segmentMatch(parts[0], item));
  // A leading ** gives slash-containing patterns the same nested-path behavior.
  const patterns = ['**', ...parts];
  let states = new Set([0]);
  const expand = (set) => { for (const i of set) if (patterns[i] === '**') set.add(i + 1); return set; };
  for (const item of items) {
    const next = new Set();
    for (const i of expand(states)) {
      if (patterns[i] === '**') next.add(i);
      else if (i < patterns.length && segmentMatch(patterns[i], item)) next.add(i + 1);
    }
    states = next;
  }
  return expand(states).has(patterns.length);
}
/** @param {string} relPath @param {{denyGlobs?:string[],extraDenyGlobs?:string[]}} options */
export function scanPath(relPath, options = {}) {
  if (typeof relPath !== 'string') throw new TypeError('Expected path to be a string');
  const normalize = (s) => s.replace(/\\/g, '/').replace(/(?:^|\/)\.\//g, '/').replace(/^\/+/, '').toLowerCase();
  const path = normalize(relPath);
  const patterns = [...DENY_GLOBS, ...(options.denyGlobs ?? []), ...(options.extraDenyGlobs ?? [])];
  const denied = patterns.some((glob) => globMatch(normalize(glob), path));
  const basename = path.slice(path.lastIndexOf('/') + 1);
  // A generic secret(s).<extension> filename remains sensitive, while Markdown
  // slugs such as team-secret-rotation-notes-v0.md are ordinary wiki page names.
  const genericSecretFile = /^secrets?\.(?!.*\.md$).+/i.test(basename);
  return denied || genericSecretFile ? [{ ruleId: 'denied-path', kind: 'path', start: 0, end: relPath.length }] : [];
}

/** Return the persisted, value-free identity for one safety finding. */
export function fingerprintSafetyFinding(relPath, text, finding) {
  if (typeof relPath !== 'string' || typeof text !== 'string' || !finding || typeof finding.ruleId !== 'string') {
    throw new TypeError('Invalid safety finding');
  }
  if (finding.kind === 'path') return { path: relPath, ruleId: finding.ruleId };
  if ((finding.kind !== 'content' && finding.kind !== 'personal') || !Number.isInteger(finding.start) || !Number.isInteger(finding.end)
      || finding.start < 0 || finding.end <= finding.start || finding.end > text.length) {
    throw new TypeError('Invalid safety finding');
  }
  const matchedBytes = Buffer.from(text.slice(finding.start, finding.end), 'utf8');
  return { path: relPath, ruleId: finding.ruleId, sha256: createHash('sha256').update(matchedBytes).digest('hex') };
}

/** Match a finding against the exact value-free entries stored in safety.allow. */
export function isSafetyFindingAllowed(relPath, text, finding, allow = []) {
  if (!Array.isArray(allow)) return false;
  const fingerprint = fingerprintSafetyFinding(relPath, text, finding);
  return allow.some((entry) => entry && entry.path === fingerprint.path && entry.ruleId === fingerprint.ruleId
    && (Object.hasOwn(fingerprint, 'sha256') ? entry.sha256 === fingerprint.sha256 : !Object.hasOwn(entry, 'sha256')));
}
/** @param {string} text @param {{rules?:object[],personal?:boolean}} options */
export function redact(text, options = {}) {
  const findings = scanText(text, options);
  // BA-26: with the personal option, e-mail and TR phone numbers are redacted too. Output only; scanText never reports them.
  if (options.personal) {
    for (const rule of CONTACT_RULES) {
      for (const match of text.matchAll(new RegExp(rule.pattern.source, 'g'))) {
        if (match[0].length) findings.push({ ruleId: rule.id, kind: 'contact', start: match.index, end: match.index + match[0].length });
      }
    }
    sortFindings(findings);
  }
  let result = '', cursor = 0;
  for (let i = 0; i < findings.length;) {
    const first = findings[i++];
    let end = first.end;
    while (i < findings.length && findings[i].start < end) end = Math.max(end, findings[i++].end);
    result += text.slice(cursor, first.start) + `[REDACTED:${first.ruleId}]`;
    cursor = end;
  }
  return result + text.slice(cursor);
}
