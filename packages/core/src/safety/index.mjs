// SPDX-License-Identifier: MIT
import { CONTENT_RULES, DENY_GLOBS } from './rules.mjs';

const placeholder = /^(?:<[^>]*>|x{3,}|changeme|example|none|null|undefined|redacted|placeholder|\$\{[^}]+\}|\$[A-Za-z_][\w]*|process\.env\.[\w]+|\*+)$/i;
const assignment = /\b([A-Za-z_][A-Za-z0-9_.-]{0,127})["']?[ \t]*[:=][ \t]*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|(\$\{[A-Za-z_][A-Za-z0-9_]*\}|[^\s,;"'\]}]+))/g;
const secretKey = /(?:password|passwd|passphrase|(?:^|[_ .-])pwd|secret|token|api[_ .-]?key|access[_ .-]?key|credential|private[_ .-]?key)/i;
const explicitKey = /(?:password|passwd|passphrase|(?:^|[_ .-])pwd|secret)/i;
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
  const add = (ruleId, start, end) => findings.push({ ruleId, kind: 'content', start, end });
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
  for (const match of text.matchAll(assignment)) {
    const key = match[1], value = match[2] ?? match[3] ?? match[4];
    if (!secretKey.test(key) || safeKey.test(key) || !value || placeholder.test(value)) continue;
    if (!explicitKey.test(key) && !highEntropy(value)) continue;
    const start = match.index + match[0].lastIndexOf(value);
    add(/aws.*secret/i.test(key) ? 'aws-secret-key' : explicitKey.test(key) ? 'secret-assignment' : 'high-entropy-assignment', start, start + value.length);
  }
  const header = /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/g;
  for (const match of text.matchAll(header)) {
    const endMarker = match[0].replace('BEGIN', 'END');
    const end = text.indexOf(endMarker, match.index + match[0].length);
    add('private-key', match.index, end < 0 ? text.length : end + endMarker.length);
  }
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
  return patterns.filter((glob) => globMatch(normalize(glob), path)).map(() => ({ ruleId: 'denied-path', kind: 'path', start: 0, end: relPath.length }));
}
/** @param {string} text @param {{rules?:object[]}} options */
export function redact(text, options = {}) {
  const findings = scanText(text, options);
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
