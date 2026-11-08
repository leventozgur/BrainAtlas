// SPDX-License-Identifier: MIT
const canonical = (value) => JSON.stringify(value, (_key, nested) => Array.isArray(nested) ? [...nested].sort() : nested);

function mergeField(baseValue, localValue, remoteValue) {
  const localChanged = canonical(localValue) !== canonical(baseValue);
  const remoteChanged = canonical(remoteValue) !== canonical(baseValue);
  if (!localChanged) return { value: remoteValue, conflict: false };
  if (!remoteChanged || canonical(localValue) === canonical(remoteValue)) return { value: localValue, conflict: false };
  return { value: undefined, conflict: true };
}

function mergeEntry(baseValue, localValue, remoteValue) {
  if (canonical(localValue) === canonical(remoteValue)) return { value: localValue, conflict: false };
  if (canonical(localValue) === canonical(baseValue)) return { value: remoteValue, conflict: false };
  if (canonical(remoteValue) === canonical(baseValue)) return { value: localValue, conflict: false };
  return { value: undefined, conflict: true };
}

function parseIndex(text) {
  const entries = new Map();
  const lines = String(text ?? '').split(/\r?\n/);
  let category = 'Uncategorized', sawCategory = false;
  const header = [];
  for (const line of lines) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) { category = heading[1]; sawCategory = true; continue; }
    const match = /^-\s+\[((?:\\.|[^\]])+)\]\(([^)]+)\)(?:\s+[—–-]\s+(.*))?\s*$/.exec(line);
    if (match) {
      const title = match[1].replace(/\\([\\\[\]])/g, '$1');
      const path = match[2];
      const metadata = match[3] ?? '';
      entries.set(path, { path, category, title, summary: metadata.replace(/#[\w-]+/g, '').trim(), tags: [...metadata.matchAll(/#([\w-]+)/g)].map((tag) => tag[1]) });
    } else if (!sawCategory) header.push(line);
  }
  return { header: header.join('\n').replace(/\n+$/, ''), entries };
}

function mergeIndexEntry(key, base, local, remote) {
  const merged = mergeEntry(base, local, remote);
  return merged.conflict
    ? { entry: null, conflicts: [{ path: key, field: 'entry' }] }
    : { entry: merged.value, conflicts: [] };
}

function renderIndex(header, entries) {
  const categories = new Map();
  for (const entry of [...entries.values()].filter(Boolean).sort((a, b) => a.category.localeCompare(b.category) || a.path.localeCompare(b.path))) {
    if (!categories.has(entry.category)) categories.set(entry.category, []);
    categories.get(entry.category).push(entry);
  }
  let result = `${header || '# Wiki Index'}\n`;
  for (const [category, rows] of categories) {
    result += `\n## ${category}\n\n`;
    for (const row of rows) {
      const title = row.title.replace(/\\/g, '\\\\').replace(/\[/g, '\\[').replace(/\]/g, '\\]');
      const metadata = [row.summary, ...(row.tags ?? []).map((tag) => `#${tag}`)].filter(Boolean).join(' ');
      result += `- [${title}](${row.path})${metadata ? ` — ${metadata}` : ''}\n`;
    }
  }
  return result;
}

export function mergeIndexThreeWay(baseText, localText, remoteText) {
  const base = parseIndex(baseText ?? '# Wiki Index\n'), local = parseIndex(localText ?? '# Wiki Index\n'), remote = parseIndex(remoteText ?? '# Wiki Index\n');
  const header = mergeField(base.header, local.header, remote.header);
  const conflicts = header.conflict ? [{ path: 'wiki/index.md', field: 'header' }] : [];
  const entries = new Map();
  for (const key of [...new Set([...base.entries.keys(), ...local.entries.keys(), ...remote.entries.keys()])].sort()) {
    const merged = mergeIndexEntry(key, base.entries.get(key), local.entries.get(key), remote.entries.get(key));
    conflicts.push(...merged.conflicts);
    if (merged.entry) entries.set(key, merged.entry);
  }
  return { content: conflicts.length ? null : renderIndex(header.value, entries), conflicts };
}

function splitLog(text) {
  const blocks = String(text ?? '# Wiki Log\n').trimEnd().split(/\r?\n\s*\r?\n/).filter(Boolean);
  const preamble = blocks.length && (/^#\s+/.test(blocks[0]) || /^<!--/.test(blocks[0])) ? blocks.shift() : '# Wiki Log';
  const entries = new Map();
  for (const block of blocks) {
    const operation = /<!--\s*sync-op:([0-9a-f-]{36})\s*-->/i.exec(block)?.[1]?.toLowerCase();
    const first = block.split(/\r?\n/, 1)[0].trim();
    const key = operation ? `op:${operation}` : `entry:${first.toLowerCase()}`;
    entries.set(key, block);
  }
  return { preamble, entries };
}

export function mergeLogThreeWay(baseText, localText, remoteText) {
  const base = splitLog(baseText), local = splitLog(localText), remote = splitLog(remoteText);
  const preamble = mergeField(base.preamble, local.preamble, remote.preamble);
  if (preamble.conflict) return { content: null, conflicts: [{ path: 'wiki/log.md', field: 'header' }] };
  const entries = new Map();
  const conflicts = [];
  const keys = new Set([...base.entries.keys(), ...local.entries.keys(), ...remote.entries.keys()]);
  for (const key of keys) {
    const merged = mergeEntry(base.entries.get(key), local.entries.get(key), remote.entries.get(key));
    if (merged.conflict) conflicts.push({ path: 'wiki/log.md', field: 'entry' });
    else if (merged.value !== undefined) entries.set(key, merged.value);
  }
  if (conflicts.length) return { content: null, conflicts };
  const ordered = [...entries.values()];
  return { content: `${preamble.value}${ordered.length ? `\n\n${ordered.join('\n\n')}` : ''}\n`, conflicts: [] };
}

export function mergeCanonicalPath(path, baseText, localText, remoteText) {
  if (path === 'wiki/index.md') return mergeIndexThreeWay(baseText, localText, remoteText);
  if (path === 'wiki/log.md') return mergeLogThreeWay(baseText, localText, remoteText);
  return { content: null, conflicts: [{ path, field: 'content' }] };
}
