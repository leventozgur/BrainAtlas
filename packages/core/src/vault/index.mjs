// SPDX-License-Identifier: MIT
import { mkdir, readFile, readdir, writeFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { BrainAtlasError } from '../util/errors.mjs';
import { atomicWriteFile, resolveSafePath } from '../util/index.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../');
const markdown = (s) => typeof s === 'string' ? s : String(s ?? '');
const validRel = (s) => typeof s === 'string' && s.length > 0 && !isAbsolute(s) && !s.includes('\\') && !s.includes('\0') && s.split('/').every((p) => p && p !== '.' && p !== '..');
const fmError = (code) => ({ code, message: code === 'E_FRONTMATTER_YAML' ? 'Frontmatter YAML is invalid.' : 'Frontmatter delimiters are invalid.' });

/** Create a standard vault tree. Existing files are never replaced. */
export async function initVault(dir, options = {}) {
  const requested = resolve(dir);
  await mkdir(requested, { recursive: true });
  const base = await realpath(requested);
  const dirs = ['wiki/entities', 'wiki/concepts', 'wiki/sources', 'wiki/summaries', 'wiki/queries', 'raw', 'inbox', 'planning'];
  for (const item of dirs) {
    const directory = await resolveSafePath(base, item);
    await mkdir(directory, { recursive: true });
  }
  const files = [
    ['wiki/index.md', await readFile(join(root, 'templates/vault/index.md'), 'utf8')],
    ['wiki/log.md', await readFile(join(root, 'templates/vault/log.md'), 'utf8')],
    ['planning/backlog.md', await readFile(join(root, 'templates/vault/backlog.md'), 'utf8')],
  ];
  const policy = await readFile(join(root, 'templates/policy/AGENTS.md'), 'utf8');
  files.push(['AGENTS.md', policy]);
  for (const [rel, content] of files) {
    const file = await resolveSafePath(base, rel);
    await mkdir(dirname(file), { recursive: true });
    try { await writeFile(file, content, { flag: 'wx' }); }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  return { path: base, created: [...dirs, ...files.map(([p]) => p)] };
}

/** Parse YAML frontmatter without allowing unquoted dates to become Date objects. */
export function parseFrontmatter(text) {
  const source = markdown(text).replace(/^\uFEFF/, '');
  const lines = source.split(/\r?\n/);
  if (lines[0] !== '---') return { data: {}, body: source, errors: [] };
  const end = lines.findIndex((line, i) => i > 0 && line === '---');
  if (end < 0) return { data: {}, body: '', errors: [fmError('E_FRONTMATTER_DELIMITER')] };
  const yamlText = lines.slice(1, end).join('\n');
  const doc = YAML.parseDocument(yamlText, { schema: 'core', uniqueKeys: true, prettyErrors: false, strict: true });
  if (doc.errors.length || (doc.contents && !YAML.isMap(doc.contents))) return { data: {}, body: lines.slice(end + 1).join('\n'), errors: [fmError('E_FRONTMATTER_YAML')] };
  // YAML 1.2 core schema treats date-like values as strings; normalize any timestamp
  // objects defensively so callers never observe timezone-dependent date shifts.
  let data;
  try { data = doc.contents ? doc.toJS({ mapAsMap: false, maxAliasCount: 0 }) : {}; }
  catch { return { data: {}, body: lines.slice(end + 1).join('\n'), errors: [fmError('E_FRONTMATTER_YAML')] }; }
  const normalize = (value) => {
    if (value instanceof Date) return Number.isNaN(value.valueOf()) ? null : value.toISOString();
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === 'object') for (const key of Object.keys(value)) value[key] = normalize(value[key]);
    return value;
  };
  return { data: normalize(data) ?? {}, body: lines.slice(end + 1).join('\n'), errors: [] };
}

export async function readPage(vaultDir, rel) {
  if (!validRel(rel)) throw new BrainAtlasError('E_PATH_ESCAPE', 'Page path is invalid.');
  const base = await realpath(resolve(vaultDir));
  const file = await resolveSafePath(base, rel);
  const parsed = parseFrontmatter(await readFile(file, 'utf8'));
  return { path: rel, ...parsed };
}

export async function listPages(vaultDir) {
  const base = resolve(vaultDir); const result = [];
  async function visit(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile() && entry.name.endsWith('.md')) result.push(relative(base, file).split(sep).join('/'));
    }
  }
  await visit(join(base, 'wiki'));
  return result.sort();
}

/** Append one serialized event; callers cannot replace prior log records. */
export async function appendLog(vaultDir, entry, options = {}) {
  const base = await realpath(resolve(vaultDir));
  const rel = 'wiki/log.md';
  const parent = await resolveSafePath(base, 'wiki');
  await mkdir(parent, { recursive: true });
  const file = await resolveSafePath(base, rel);
  const timestamp = (options.now ?? new Date()).toISOString();
  const safeEntry = {};
  if (typeof entry?.action === 'string' && /^[a-z][a-z0-9_-]{0,31}$/i.test(entry.action)) safeEntry.action = entry.action;
  if (typeof entry?.path === 'string' && entry.path.startsWith('wiki/') && validRel(entry.path) && entry.path.length <= 240) safeEntry.path = entry.path;
  let content = '';
  try { content = await readFile(file, 'utf8'); }
  catch (cause) { if (cause?.code !== 'ENOENT') throw cause; }
  await (options.atomicWriter ?? atomicWriteFile)(file, `${content}\n- ${timestamp} ${JSON.stringify(safeEntry)}\n`);
}

/** Upsert a path/title row under the index Entries heading. */
export async function upsertIndexEntry(vaultDir, entry) {
  if (!validRel(entry?.path) || !entry.path.startsWith('wiki/') || typeof entry.title !== 'string' || !entry.title.trim()) throw new BrainAtlasError('E_INDEX_ENTRY', 'Index entry is invalid.');
  const base = await realpath(resolve(vaultDir));
  const rel = 'wiki/index.md';
  const file = await resolveSafePath(base, rel);
  await mkdir(dirname(file), { recursive: true });
  let content; try { content = await readFile(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; content = '# Wiki index\n'; }
  const row = `- [${entry.title.replace(/[\[\]]/g, '')}](${entry.path})`;
  const lines = content.split(/\r?\n/).filter((line) => !/^\s*- \[[^\]]*\]\(wiki\/[^)]*\)\s*$/.test(line) || !line.includes(`(${entry.path})`));
  const heading = lines.findIndex((line) => /^##? Entries\s*$/i.test(line));
  if (heading < 0) lines.push('', '## Entries', row);
  else lines.splice(heading + 1, 0, row);
  await atomicWriteFile(file, lines.join('\n').replace(/\n*$/, '\n'));
}
