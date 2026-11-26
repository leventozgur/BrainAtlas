// SPDX-License-Identifier: MIT
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { packageRootFromUrl } from '../paths/index.mjs';
import { atomicWriteFile } from '../util/index.mjs';

const root = packageRootFromUrl(import.meta.url);
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const FILES = Object.freeze([
  { name: 'AGENTS.md', template: 'templates/policy/AGENTS.md' },
  { name: 'CLAUDE.md', template: 'templates/agent-pointers/CLAUDE.md' },
]);
const USER_MARKER = '<!-- migrated:user-section -->';
const MANAGED =
  /<!-- brainatlas:managed v=(\d+) sha256=([0-9a-f]{64}) -->\r?\n([\s\S]*?)\r?\n<!-- \/brainatlas:managed -->/;
export const POLICY_TOOLS = Object.freeze([
  'wiki_query',
  'wiki_read_page',
  'wiki_read_index',
  'wiki_list_pages',
  'wiki_status',
  'wiki_lint',
  'wiki_write_page',
  'wiki_update_page',
  'wiki_create_entity',
  'wiki_create_concept',
  'wiki_add_crosslinks',
  'wiki_update_index',
]);
const DEFAULT_COMMANDS = Object.freeze([
  'init',
  'install',
  'status',
  'doctor',
  'config',
  'safety',
  'module',
  'agent',
  'ui',
  'uninstall',
  'update',
  'rollback',
  'recover',
  'eval',
  'hook',
  'mcp',
  'migrate',
  'adopt',
  'maintain',
  'compact',
  'usage',
  'wiki',
  'help',
]);

export const POLICY_VERSION = 2;

/** Released template sha256 values grouped by the policy version that shipped them. */
export const POLICY_HASHES = Object.freeze({
  1: Object.freeze([
    'c8243873e1a39b07ede4b850f4e3fd0183578ece97badaade076bc1ecb22dd7e',
    'b449bffbb14385c0bc2666ea13de3ace1b56542b4f9a38cc9ac584f42a5266c1',
    '97134dfe6c8868b7b1f75924f49997811710dc076439975b0d715a894c3cabe4',
    '8a61bab2e2d1aed25008edc85f0bfccf34f4975ea0f2a4ec56a4b23f946e8d46',
    '0661b8fddf8a2c74100a44aa07b5506932efd50c3cf7d85db1b679a9b8aca6ee',
    '44b470b59da25a993ec9c08c631cf14a60cdf0b729a2fdf441a15bdd90bf591f',
  ]),
  [POLICY_VERSION]: Object.freeze([
    '67e31ffd55d4cfaf0de45414b607b2b7129d67627bc1c5921c2699163a9d651e',
    '8efa131ec632da646e8bac8fbc8ef052effa06cb715256303f018fd5b88bbb3f',
    '0661b8fddf8a2c74100a44aa07b5506932efd50c3cf7d85db1b679a9b8aca6ee',
    '44b470b59da25a993ec9c08c631cf14a60cdf0b729a2fdf441a15bdd90bf591f',
  ]),
});

/** Reverse of POLICY_HASHES: each released sha256 mapped to its policy version. */
export const POLICY_TEXTS = Object.freeze(
  Object.fromEntries(
    Object.entries(POLICY_HASHES).flatMap(([version, hashes]) => hashes.map((hash) => [hash, Number(version)]))
  )
);

/** The managed block for one template text, keeping the text and its sha256 byte for byte. */
export function managedPolicyBlock(text) {
  const body = String(text);
  return `<!-- brainatlas:managed v=${POLICY_VERSION} sha256=${sha256(body)} -->\n${body}\n<!-- /brainatlas:managed -->\n`;
}

async function templateFor(file) {
  return readFile(join(root, file.template), 'utf8');
}

async function fileState(base, name) {
  const path = join(base, name);
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (error.code === 'ENOENT') return { path, missing: true };
    return { path, unreadable: error.code ?? 'error' };
  }
  if (info.isSymbolicLink()) return { path, symlink: true };
  if (!info.isFile()) return { path, regular: false };
  try {
    const raw = await readFile(path);
    const text = raw.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(raw)) return { path, invalidUtf8: true, mode: info.mode & 0o777 };
    return { path, text, mode: info.mode & 0o777 };
  } catch (error) {
    return { path, unreadable: error.code ?? 'error' };
  }
}

const backupFile = (file) => `${file}.bak.${new Date().toISOString().replace(/[:.]/g, '-')}`;
const writePolicy = (file, content, mode) => atomicWriteFile(file, content, { mode });

/**
 * Bring AGENTS.md and CLAUDE.md up to the current managed policy block.
 * @param {{vaultDir: string, plan?: boolean, force?: boolean}} options
 */
export async function refreshVaultPolicy({ vaultDir, plan = false, force = false }) {
  const changes = [];
  const warnings = [];
  let needsConfirmation = false;
  let base;
  try {
    base = await realpath(vaultDir);
  } catch {
    warnings.push(`${vaultDir}: the vault directory does not exist.`);
    return { changes, warnings, needsConfirmation };
  }
  for (const file of FILES) {
    const state = await fileState(base, file.name);
    if (state.unreadable) {
      warnings.push(`${file.name} could not be read (${state.unreadable}).`);
      changes.push({ path: file.name, action: 'none' });
      continue;
    }
    if (state.invalidUtf8) {
      warnings.push(`${file.name} is not valid UTF-8; the policy was not refreshed.`);
      changes.push({ path: file.name, action: 'none' });
      continue;
    }
    if (state.missing) {
      changes.push({ path: file.name, action: file.name === 'AGENTS.md' ? 'create' : 'none' });
      if (file.name === 'AGENTS.md' && !plan)
        await writePolicy(state.path, managedPolicyBlock(await templateFor(file)));
      continue;
    }
    if (state.symlink || state.regular === false) {
      warnings.push(
        `${file.name}: ${state.symlink ? 'the file is a symbolic link and was not followed' : 'the file is not a regular file'}; the managed block was not refreshed.`
      );
      changes.push({ path: file.name, action: 'none' });
      continue;
    }
    const template = await templateFor(file);
    const eol = state.text.includes('\r\n') ? '\r\n' : '\n';
    const block = eol === '\n' ? managedPolicyBlock(template) : managedPolicyBlock(template).replace(/\n/g, eol);
    const managed = MANAGED.exec(state.text);
    if (managed) {
      const head = state.text.slice(0, managed.index);
      const tail = state.text.slice(managed.index + managed[0].length).replace(/^\r?\n/, '');
      const body = managed[3].replace(/\r\n/g, '\n');
      if (Number(managed[1]) > POLICY_VERSION) {
        warnings.push(
          `${file.name}: the managed policy was written by a newer BrainAtlas (v${managed[1]}); update this device.`
        );
        changes.push({ path: file.name, action: 'none' });
        continue;
      }
      if (sha256(body) !== managed[2]) {
        if (!force) {
          warnings.push(
            `${file.name}: the BrainAtlas managed block was edited; run brainatlas agent refresh --force to replace it (a backup is kept).`
          );
          needsConfirmation = true;
          changes.push({ path: file.name, action: 'none' });
          continue;
        }
        if (!plan) {
          await writePolicy(backupFile(state.path), state.text, state.mode);
          await writePolicy(state.path, head + block + tail, state.mode);
        }
        changes.push({ path: file.name, action: 'update' });
        continue;
      }
      if (body === template) {
        changes.push({ path: file.name, action: 'none' });
        continue;
      }
      if (!plan) await writePolicy(state.path, head + block + tail, state.mode);
      changes.push({ path: file.name, action: 'update' });
      continue;
    }
    const markerIndex = state.text.indexOf(USER_MARKER);
    const prefix = markerIndex < 0 ? state.text : state.text.slice(0, markerIndex);
    const suffix = markerIndex < 0 ? '' : state.text.slice(markerIndex);
    const trimmedPrefix = prefix.trim();
    if (trimmedPrefix === '') {
      if (!plan) await writePolicy(state.path, block + suffix, state.mode);
      changes.push({ path: file.name, action: 'update' });
      continue;
    }
    const released = POLICY_TEXTS[sha256(prefix)] !== undefined || POLICY_TEXTS[sha256(trimmedPrefix)] !== undefined;
    if (released || trimmedPrefix === template.trim()) {
      if (!plan) await writePolicy(state.path, block + suffix, state.mode);
      changes.push({ path: file.name, action: 'update' });
      continue;
    }
    if (!force) {
      warnings.push(
        `${file.name}: no BrainAtlas managed block; run brainatlas agent refresh --force to add one (a backup is kept).`
      );
      needsConfirmation = true;
      changes.push({ path: file.name, action: 'none' });
      continue;
    }
    const previous = prefix
      ? `<!-- brainatlas:previous -->\n${prefix.endsWith('\n') ? prefix : `${prefix}\n`}<!-- /brainatlas:previous -->\n`
      : '';
    if (!plan) {
      await writePolicy(backupFile(state.path), state.text, state.mode);
      await writePolicy(state.path, block + previous + suffix, state.mode);
    }
    changes.push({ path: file.name, action: 'update' });
  }
  return { changes, warnings, needsConfirmation };
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Report stale paths, tools, commands and removed scripts in the user-owned text of both policy files.
 * @param {{vaultDir: string, home?: string, knownTools?: Iterable<string>, knownCommands?: Iterable<string>}} options
 */
export async function lintPolicyReferences({ vaultDir, home, knownTools, knownCommands }) {
  const warnings = [];
  let base;
  try {
    base = await realpath(vaultDir);
  } catch {
    return { warnings };
  }
  const tools = new Set(knownTools ?? POLICY_TOOLS);
  const commands = new Set(knownCommands ?? DEFAULT_COMMANDS);
  const homeDir = home ?? process.env.HOME ?? '';
  for (const file of FILES) {
    const state = await fileState(base, file.name);
    if (!state.text) continue;
    const managed = MANAGED.exec(state.text);
    const text = managed
      ? state.text.slice(0, managed.index) + state.text.slice(managed.index + managed[0].length)
      : state.text;
    const found = new Set();
    const add = (warning) => {
      if (found.size < 10) found.add(warning);
    };
    for (const match of text.matchAll(/(?<![\w:/\\])(?:~\/|\/Users\/|\/home\/|[A-Za-z]:[\\/])[^\s`)]*/g)) {
      if (text.slice(Math.max(0, match.index - 10), match.index).includes('://')) continue;
      const token = match[0].replace(/[.,;:]+$/, '');
      const target = token.startsWith('~/') ? join(homeDir, token.slice(2)) : token;
      if (!(await exists(target))) add(`${file.name}: path ${token} does not exist on this device.`);
    }
    for (const match of text.matchAll(/\b(?:wiki|plan)_[a-z_]+\b/g))
      if (!tools.has(match[0])) add(`${file.name}: tool ${match[0]} does not exist.`);
    for (const match of text.matchAll(/\bbrainatlas[ \t]+([a-z][a-z0-9-]*)/g))
      if (!commands.has(match[1])) add(`${file.name}: command brainatlas ${match[1]} does not exist.`);
    for (const match of text.matchAll(/\b(?:ba|checkpoint)\.mjs\b/g))
      add(`${file.name}: ${match[0]} is no longer part of BrainAtlas.`);
    warnings.push(...found);
  }
  return { warnings };
}
