// SPDX-License-Identifier: MIT
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import * as core from '@brainatlas/core';

const error = (code, message) => Object.assign(new Error(message), { code });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const categories = ['wiki', 'planning', 'raw', 'inbox', 'archive'];
const instructionNames = new Set(['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', 'COPILOT.md', 'CODEX.md', 'CURSOR.md', 'WINDSURF.md']);
const instructionMarker = '<!-- migrated:user-section -->';

async function pathInfo(path) {
  try { return await lstat(path); } catch (cause) { if (cause.code === 'ENOENT') return null; throw cause; }
}

async function realDestination(path) {
  let current = resolve(path); const tail = [];
  while (!(await pathInfo(current))) {
    const parent = dirname(current);
    if (parent === current) throw error('E_TARGET_INVALID', 'Migration destination is invalid.');
    tail.unshift(current.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
    current = parent;
  }
  const stat = await lstat(current);
  if (stat.isSymbolicLink()) current = await realpath(current);
  else current = await realpath(current);
  return resolve(current, ...tail);
}

function inside(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

async function validateRoots(from, to, { requireEmpty = true } = {}) {
  const sourcePath = resolve(from); const sourceStat = await pathInfo(sourcePath);
  if (!sourceStat || !sourceStat.isDirectory() || sourceStat.isSymbolicLink()) throw error('E_SOURCE_INVALID', 'Source vault is unavailable or invalid.');
  const source = await realpath(sourcePath);
  const target = resolve(to); const targetStat = await pathInfo(target);
  if (targetStat && (!targetStat.isDirectory() || targetStat.isSymbolicLink())) throw error('E_TARGET_INVALID', 'Migration destination is not a regular directory.');
  const targetReal = await realDestination(target);
  if (inside(source, targetReal)) throw error('E_TARGET_INVALID', 'Migration destination must be outside the source vault.');
  if (inside(targetReal, source)) throw error('E_TARGET_INVALID', 'Migration destination cannot contain the source vault.');
  if (requireEmpty && targetStat) {
    const entries = await readdir(target);
    if (entries.length) throw error('E_TARGET_NOT_EMPTY', 'Migration destination is not empty.');
  }
  return { source, target, targetStat };
}

async function countExcludedTree(path) {
  const stat = await pathInfo(path);
  if (!stat) return 0;
  if (!stat.isDirectory() || stat.isSymbolicLink()) return 1;
  let count = 1;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    count += await countExcludedTree(join(path, entry.name));
  }
  return count;
}

async function scanTree(root, relRoot, record, skipped) {
  const absolute = join(root, relRoot);
  const rootStat = await pathInfo(absolute);
  if (!rootStat) return;
  if (rootStat.isSymbolicLink()) { skipped.symlinks++; return; }
  if (!rootStat.isDirectory()) { skipped.invalidCategory++; return; }
  record.directories.push(relRoot);
  async function visit(dir, relDir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const file = join(dir, entry.name); const rel = `${relDir}/${entry.name}`; const stat = await lstat(file);
      if (stat.isSymbolicLink()) { skipped.symlinks++; continue; }
      if (stat.isDirectory()) { record.directories.push(rel); await visit(file, rel); }
      else if (stat.isFile()) record.files.push({ path: rel, size: stat.size, category: relRoot });
    }
  }
  await visit(absolute, relRoot);
}

async function templateFor(name) {
  if (name === 'AGENTS.md') return readFile(new URL('../../../templates/policy/AGENTS.md', import.meta.url));
  try { return await readFile(new URL(`../../../templates/agent-pointers/${name}`, import.meta.url)); }
  catch (cause) { if (cause.code === 'ENOENT') return null; throw cause; }
}

async function inspectSource(source) {
  const record = { files: [], directories: [], instructions: [], skipped: { git: 0, gitHistory: 'use git bundle, not copied', obsidian: 0, trash: 0, symlinks: 0, invalidCategory: 0, unsupportedInstructions: 0, otherRootFiles: 0 } };
  for (const category of categories) await scanTree(source, category, record, record.skipped);
  record.skipped.git = (await pathInfo(join(source, '.git'))) ? 1 : 0;
  record.skipped.obsidian = await countExcludedTree(join(source, '.obsidian'));
  record.skipped.trash = await countExcludedTree(join(source, '.trash'));
  const rootEntries = await readdir(source, { withFileTypes: true });
  for (const entry of rootEntries) {
    if (['.git', '.obsidian', '.trash'].includes(entry.name) || categories.includes(entry.name)) continue;
    const file = join(source, entry.name); const stat = await lstat(file);
    if (stat.isSymbolicLink()) { record.skipped.symlinks++; continue; }
    if (stat.isFile() && instructionNames.has(entry.name)) {
      const template = await templateFor(entry.name);
      if (template) {
        const old = await readFile(file);
        record.instructions.push({ path: entry.name, template, old });
      } else record.skipped.unsupportedInstructions++;
    } else if (stat.isFile()) record.skipped.otherRootFiles++;
    else if (stat.isDirectory()) record.skipped.otherRootFiles++;
  }
  if (!record.instructions.some(item => item.path === 'AGENTS.md')) {
    record.instructions.push({ path: 'AGENTS.md', template: await templateFor('AGENTS.md'), old: null });
  }
  record.files.sort((a, b) => a.path.localeCompare(b.path));
  record.directories = [...new Set(record.directories)].sort((a, b) => a.localeCompare(b));
  record.instructions.sort((a, b) => a.path.localeCompare(b.path));
  return record;
}

function instructionBytes(item) {
  const templateText = item.template.toString('utf8').replace(/\s*$/, '\n');
  if (!item.old) return Buffer.from(templateText);
  const oldText = item.old.toString('utf8');
  if (oldText === item.template.toString('utf8')) return Buffer.from(templateText);
  let userText = oldText;
  if (oldText.includes(instructionMarker)) {
    userText = oldText.split(instructionMarker).slice(1).map(section => section.split('<!-- /migrated:user-section -->')[0]).join('\n').trim();
  } else {
    const previousTemplate = item.template.toString('utf8');
    if (oldText.includes(previousTemplate)) userText = oldText.replace(previousTemplate, '').trim();
    else userText = oldText.trim();
  }
  if (!userText) return Buffer.from(templateText);
  const output = `${templateText}\n${instructionMarker}\n${userText.replace(/\s*$/, '')}\n<!-- /migrated:user-section -->\n`;
  return Buffer.from(output);
}

function migrationSummary(record) {
  const generated = record.instructions.map(item => ({ path: item.path, size: instructionBytes(item).length }));
  const files = record.files.length + generated.length;
  const bytes = record.files.reduce((sum, item) => sum + item.size, 0) + generated.reduce((sum, item) => sum + item.size, 0);
  const pages = record.files.filter(item => item.category === 'wiki' && item.path.endsWith('.md')).length;
  const samplePaths = [...record.files.map(item => item.path), ...generated.map(item => item.path)].sort((a, b) => a.localeCompare(b)).slice(0, 10);
  return { pages, files, bytes, skipped: structuredClone(record.skipped), samplePaths };
}

export async function planMigration(from, to, options = {}) {
  const roots = await validateRoots(from, to, { requireEmpty: options.requireEmpty !== false });
  const record = await inspectSource(roots.source);
  return { roots, record, summary: migrationSummary(record) };
}

function bodyOf(bytes) {
  return core.parseFrontmatter(bytes.toString('utf8')).body;
}

async function checkIndexLog(vault) {
  for (const path of ['wiki/index.md', 'wiki/log.md']) {
    const file = join(vault, path); const stat = await pathInfo(file);
    if (!stat || !stat.isFile() || stat.isSymbolicLink()) return false;
    try { await readFile(file); } catch { return false; }
  }
  const log = await readFile(join(vault, 'wiki/log.md'), 'utf8');
  return /\"action\":\"migrated\"/.test(log);
}

export async function migrateVault(from, to, { plan = false } = {}) {
  const { roots, record, summary } = await planMigration(from, to);
  if (plan) return { action: 'migrate', from: roots.source, to: roots.target, ...summary };
  if (!roots.targetStat) await mkdir(roots.target, { recursive: true });
  for (const directory of record.directories) await mkdir(join(roots.target, directory), { recursive: true });
  for (const item of record.files) {
    const sourcePath = join(roots.source, item.path); const stat = await lstat(sourcePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw error('E_SOURCE_CHANGED', 'Source vault changed during migration.');
    const bytes = await readFile(sourcePath);
    if (bytes.length !== item.size) throw error('E_SOURCE_CHANGED', 'Source vault changed during migration.');
    const targetPath = join(roots.target, item.path);
    await mkdir(dirname(targetPath), { recursive: true }); await writeFile(targetPath, bytes, { flag: 'wx' });
  }
  for (const item of record.instructions) await writeFile(join(roots.target, item.path), instructionBytes(item), { flag: 'wx' });

  await core.appendLog(roots.target, { action: 'migrated', path: 'wiki/index.md' });
  let bodyHashMatch = true;
  for (const item of record.files.filter(entry => entry.category === 'wiki' && entry.path.endsWith('.md') && entry.path !== 'wiki/log.md')) {
    const sourceBytes = await readFile(join(roots.source, item.path)); const targetBytes = await readFile(join(roots.target, item.path));
    if (hash(Buffer.from(bodyOf(sourceBytes))) !== hash(Buffer.from(bodyOf(targetBytes)))) bodyHashMatch = false;
  }
  const sourceLog = record.files.some(item => item.path === 'wiki/log.md')
    ? await readFile(join(roots.source, 'wiki/log.md'))
    : Buffer.alloc(0);
  const targetLog = await readFile(join(roots.target, 'wiki/log.md'));
  const logPrefixPreserved = targetLog.subarray(0, sourceLog.length).equals(sourceLog);
  const findings = await core.checkVault(roots.target);
  const integrity = await checkIndexLog(roots.target);
  const lintErrors = findings.filter(item => item.severity === 'error').length + (integrity ? 0 : 1);
  const okfWarnings = findings.filter(item => item.severity === 'warn').length;
  return { pages: summary.pages, files: summary.files, bytes: summary.bytes, bodyHashMatch, logPrefixPreserved, logAppendedEntries: 1, skipped: summary.skipped, okfWarnings, lintErrors };
}

const scanConfigFiles = [
  ['claude-code', '.claude.json'], ['claude-code', '.claude/settings.json'], ['claude-code', '.claude/settings.local.json'], ['codex', '.codex/config.toml'], ['codex', '.codex/hooks.json'],
  ['gemini-cli', '.gemini/settings.json'], ['kiro', '.kiro/settings/mcp.json'], ['kiro', '.kiro/hooks/brainatlas.json'],
  ['copilot-vscode', '.copilot/mcp-config.json'], ['copilot-vscode', '.copilot/hooks/brainatlas.json'], ['copilot-vscode', '.config/Code/User/mcp.json'],
  ['cursor', '.cursor/mcp.json'], ['continue', '.continue/config.json']
];

async function findVaultCandidates(home) {
  const found = []; let visited = 0;
  async function visit(dir, depth) {
    if (depth > 8 || visited >= 10000) return;
    let entries; try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    visited++;
    const wiki = join(dir, 'wiki'); const index = join(wiki, 'index.md');
    const wikiStat = await pathInfo(wiki); const indexStat = await pathInfo(index);
    if (wikiStat?.isDirectory() && !wikiStat.isSymbolicLink() && indexStat?.isFile() && !indexStat.isSymbolicLink()) found.push(resolve(dir));
    if (depth === 8) return;
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || ['.git', 'node_modules', '.cache', '.Trash', '.obsidian'].includes(entry.name)) continue;
      await visit(join(dir, entry.name), depth + 1);
    }
  }
  await visit(home, 0);
  return [...new Set(found)].sort((a, b) => a.localeCompare(b));
}

function walkValues(value, callback, key = '') {
  callback(value, key);
  if (value && typeof value === 'object') for (const [childKey, child] of Object.entries(value)) walkValues(child, callback, childKey);
}

function inspectConfigText(text) {
  let parsed = null; try { parsed = JSON.parse(text); } catch {}
  const servers = new Set(); let promptHook = false;
  if (parsed) {
    walkValues(parsed, (value, key) => {
      if (key.toLowerCase() === 'hooks' && value && typeof value === 'object') {
        let serialized = ''; try { serialized = JSON.stringify(value); } catch {}
        if (/UserPromptSubmit|BeforeSubmit|prompt[-_ ]?hook|\bhook[^\n]*\bprompt\b/i.test(serialized)) promptHook = true;
      }
      if ((key.toLowerCase() === 'mcpservers' || key.toLowerCase() === 'servers') && value && typeof value === 'object') {
        for (const [name, config] of Object.entries(value)) {
          let serialized = ''; try { serialized = JSON.stringify(config); } catch {}
          if (name.toLowerCase() === 'second-brain' || /wiki_query/i.test(serialized)) servers.add(name);
        }
      }
    });
  }
  if (/wiki_query/i.test(text)) servers.add('wiki_query provider');
  if (/second-brain/i.test(text) && !servers.size) servers.add('second-brain');
  if (/\b(UserPromptSubmit|BeforeSubmit|prompt[-_ ]?hook)\b/i.test(text)) promptHook = true;
  return { servers: [...servers].sort(), promptHook };
}

export async function adoptPlan(home, cwd = process.cwd()) {
  if (!home || typeof home !== 'string') throw error('E_HOME_INVALID', 'HOME is unavailable for adoption scan.');
  const base = resolve(home); const baseStat = await pathInfo(base);
  if (!baseStat?.isDirectory() || baseStat.isSymbolicLink()) throw error('E_HOME_INVALID', 'HOME is unavailable for adoption scan.');
  const candidates = await findVaultCandidates(base);
  const files = new Map();
  for (const [agent, rel] of scanConfigFiles) files.set(join(base, rel), agent);
  for (const vault of candidates) {
    for (const rel of ['.mcp.json', '.claude/settings.json', '.codex/config.toml', '.codex/hooks.json', '.gemini/settings.json', '.kiro/settings/mcp.json', '.kiro/hooks/brainatlas.json', '.vscode/mcp.json']) {
      files.set(join(vault, rel), rel.includes('codex') ? 'codex' : rel.includes('gemini') ? 'gemini-cli' : rel.includes('kiro') ? 'kiro' : rel.includes('vscode') ? 'copilot-vscode' : 'claude-code');
    }
  }
  const existing = [];
  for (const [file, agent] of files) {
    const stat = await pathInfo(file); if (!stat?.isFile() || stat.isSymbolicLink()) continue;
    let text; try { text = await readFile(file, 'utf8'); } catch { continue; }
    const findings = inspectConfigText(text);
    if (findings.servers.length) existing.push({ agent, path: file, servers: findings.servers });
    if (findings.promptHook) existing.push({ agent, path: file, promptHook: true });
  }
  const target = join(base, 'BrainAtlas');
  const source = candidates.find(path => path !== target) ?? candidates[0] ?? null;
  let migration = null;
  if (source) {
    try {
      const planned = await planMigration(source, target, { requireEmpty: false });
      migration = { from: source, to: target, ...planned.summary, targetEmpty: !planned.roots.targetStat || (await readdir(target)).length === 0 };
    } catch (cause) {
      migration = { from: source, to: target, error: cause.code || 'E_MIGRATION_PLAN' };
    }
  }
  const recommendation = core.defaultConfig('lite');
  recommendation.vault.path = target;
  recommendation.agents = [...new Set(existing.filter(item => item.servers || item.promptHook).map(item => item.agent))].sort();
  return {
    action: 'adopt',
    existingMcpServers: existing.filter(item => item.servers),
    promptHooks: existing.filter(item => item.promptHook),
    vaultCandidates: candidates,
    recommendedConfig: recommendation,
    migration
  };
}
