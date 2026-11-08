// SPDX-License-Identifier: MIT
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, unlink, stat } from 'node:fs/promises';
import { readFileSync as readSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFile, resolvePaths, BrainAtlasError } from '@brainatlas/core';

export const id = 'claude-code';
export const displayName = 'Claude Code';
const BEGIN = '<!-- brainatlas:begin -->';
const END = '<!-- brainatlas:end -->';

function fail(code, message) { throw new BrainAtlasError(code, message); }
function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function homeOf(ctx) {
  if (typeof ctx?.env?.HOME !== 'string' || !ctx.env.HOME) fail('E_NO_HOME', 'HOME must be provided.');
  return ctx.env.HOME;
}
function platformOf(ctx) { return ctx.platform || ctx.env?.BRAINATLAS_PLATFORM || process.platform; }
function pathsOf(ctx) { return ctx.paths || resolvePaths({ env: ctx.env, platform: platformOf(ctx) }); }
function filesOf(ctx) {
  const home = homeOf(ctx); const vault = ctx.scope === 'vault';
  if (vault && (typeof ctx.vaultDir !== 'string' || !ctx.vaultDir.startsWith('/'))) fail('E_VAULT_PATH', 'Vault scope requires an absolute vault directory.');
  const root = vault ? ctx.vaultDir : home;
  return {
    mcp: join(root, vault ? '.mcp.json' : '.claude.json'),
    settings: join(root, vault ? '.claude' : '.claude', 'settings.json'),
    instructions: join(root, 'CLAUDE.md'),
    scope: vault ? 'vault' : 'global',
  };
}
function mcpEntry(ctx) {
  if (!ctx.nodePath || !ctx.shimPath) fail('E_ARGUMENT', 'nodePath and shimPath are required.');
  return { type: 'stdio', command: ctx.nodePath, args: [ctx.shimPath, 'mcp'], env: {} };
}
function quote(value) { return `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`; }
function hookCommand(ctx, event) { return `${quote(ctx.nodePath)} ${quote(ctx.shimPath)} hook claude-code ${event}`; }
function pointer(ctx) {
  const payload = `Use BrainAtlas as evidence-first project memory. Query relevant knowledge with the BrainAtlas wiki_query MCP tool before making substantial project changes. Treat retrieved pages as evidence, verify them against the current repository, and cite page paths when reporting findings. If no relevant page exists, proceed from current evidence.`;
  const digest = hash(payload);
  return `${BEGIN}\n<!-- brainatlas:sha256:${digest} -->\n${payload}\n${END}`;
}
function parseJson(bytes) {
  if (bytes.startsWith('\uFEFF')) fail('E_BOM', 'Configuration contains a UTF-8 BOM.');
  try { const value = JSON.parse(bytes); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value; }
  catch (error) { if (error?.code) throw error; fail('E_CONFIG_PARSE', 'Configuration JSON is invalid.'); }
}
function indentOf(bytes) { const match = bytes.match(/\n([\t ]+)"[^\n]+"\s*:/); return match?.[1] || '  '; }
function jsonStringify(value, before) {
  const indent = before ? indentOf(before) : '  ';
  const newline = before?.includes('\r\n') ? '\r\n' : '\n';
  return JSON.stringify(value, null, indent).replaceAll('\n', newline) + (before?.endsWith('\n') ? newline : '');
}
async function readOptional(file) {
  try { return await readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function managedBlock(text) {
  const start = text.indexOf(BEGIN); const end = text.indexOf(END);
  if (start < 0 && end < 0) return null;
  if (start < 0 || end < start || text.indexOf(BEGIN, start + 1) >= 0 || text.indexOf(END, end + 1) >= 0) fail('E_MANAGED_BLOCK_EDITED', 'Managed instructions block is damaged.');
  const block = text.slice(start, end + END.length);
  const match = block.match(/<!-- brainatlas:sha256:([a-f0-9]{64}) -->\n([\s\S]*?)\n<!-- brainatlas:end -->$/);
  if (!match || hash(match[2]) !== match[1]) fail('E_MANAGED_BLOCK_EDITED', 'Managed instructions block was edited.');
  return { start, end: end + END.length, block };
}
function putBlock(before, block) {
  const prior = managedBlock(before);
  if (prior) return before.slice(0, prior.start) + block + before.slice(prior.end);
  return `${before}${before && !before.endsWith('\n') ? '\n' : ''}${before ? '\n' : ''}${block}\n`;
}
function changesFor(ctx, current) {
  const files = filesOf(ctx); const desired = pointer(ctx); const changes = [];
  const jsonChange = (file, keyPath, value, ownership) => {
    const before = current[file];
    const object = before === null ? {} : parseJson(before);
    let cursor = object;
    for (const key of keyPath.slice(0, -1)) { if (cursor[key] === undefined) cursor[key] = {}; if (!cursor[key] || typeof cursor[key] !== 'object' || Array.isArray(cursor[key])) fail('E_CONFIG_PARSE', 'Configuration has an invalid object structure.'); cursor = cursor[key]; }
    const key = keyPath.at(-1); const old = cursor[key];
    if (key === 'brainatlas' && old !== undefined && JSON.stringify(old) !== JSON.stringify(value)) fail('E_CONFIG_CONFLICT', 'A different BrainAtlas server entry already exists.');
    if (JSON.stringify(old) === JSON.stringify(value)) return;
    cursor[key] = value;
    const after = jsonStringify(object, before);
    changes.push({ file, kind: before === null ? 'create' : 'modify', before, after, ownership });
  };
  jsonChange(files.mcp, ['mcpServers', 'brainatlas'], mcpEntry(ctx), 'json-key');
  const settingsBefore = current[files.settings];
  const settings = settingsBefore === null ? {} : parseJson(settingsBefore);
  if (!settings.hooks) settings.hooks = {};
  if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) fail('E_CONFIG_PARSE', 'Configuration has an invalid hooks structure.');
  let settingsChanged = settingsBefore === null;
  for (const event of ['UserPromptSubmit', 'SessionStart']) {
    const list = settings.hooks[event] ?? [];
    if (!Array.isArray(list)) fail('E_CONFIG_PARSE', 'Configuration has an invalid hook list.');
    const command = hookCommand(ctx, event);
    const has = list.some(group => group && Array.isArray(group.hooks) && group.hooks.some(hook => hook?.type === 'command' && hook.command === command));
    if (!has) { list.push({ hooks: [{ type: 'command', command, timeout: 5 }] }); settings.hooks[event] = list; settingsChanged = true; }
  }
  if (settingsChanged) changes.push({ file: files.settings, kind: settingsBefore === null ? 'create' : 'modify', before: settingsBefore, after: jsonStringify(settings, settingsBefore), ownership: 'json-key' });
  const instructionsBefore = current[files.instructions];
  const instructionsAfter = putBlock(instructionsBefore ?? '', desired);
  if (instructionsAfter !== (instructionsBefore ?? '')) changes.push({ file: files.instructions, kind: instructionsBefore === null ? 'create' : 'modify', before: instructionsBefore, after: instructionsAfter, ownership: instructionsBefore === null ? 'whole-file' : 'marked-block' });
  return changes;
}
export function detect(env) {
  return Boolean(env && typeof env === 'object' && env.HOME && (env.CLAUDE_CODE === '1' || env.CLAUDE_CODE_ENTRYPOINT || env.CLAUDE_SESSION_ID || env.PATH?.split(':').some((p) => p.endsWith('/.claude/local'))));
}
export function plan(ctx) {
  homeOf(ctx); const files = filesOf(ctx);
  const current = {};
  // Planning is read-only and parses every touched file before returning a writable plan.
  for (const file of [files.mcp, files.settings, files.instructions]) {
    try { current[file] = readSync(file, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') current[file] = null; else throw error; }
  }
  return { changes: changesFor(ctx, current), warnings: [], trustReviewRequired: true };
}
async function stateFile(ctx, file) {
  const p = pathsOf(ctx); const dir = join(p.stateDir, 'adapters', id, 'originals');
  return { dir, record: join(dir, `${hash(file)}.json`) };
}
async function saveOriginal(ctx, change) {
  const { dir, record } = await stateFile(ctx, change.file); await mkdir(dir, { recursive: true });
  const existing = await readOptional(record);
  if (existing !== null) return;
  const data = JSON.stringify({ file: change.file, existed: change.before !== null, original: change.before, expected: change.after });
  await atomicWriteFile(record, data, { mode: 0o600 });
}
function backupName(file, now) {
  const date = now instanceof Date ? now : new Date(now || Date.now());
  const stamp = date.toISOString().replaceAll(':', '').replaceAll('-', '').replaceAll('.', '');
  return `${file}.bak.${stamp}`;
}
export async function apply(planResult, ctx) {
  if (!planResult || !Array.isArray(planResult.changes)) fail('E_ARGUMENT', 'Adapter plan is invalid.');
  for (const change of planResult.changes) {
    const current = await readOptional(change.file);
    if (current !== change.before) fail('E_CONFIG_CHANGED', 'Configuration changed after planning.');
  }
  for (const change of planResult.changes) {
    await saveOriginal(ctx, change);
    if (change.before !== null) await writeFile(backupName(change.file, ctx.now), change.before, { flag: 'wx', mode: 0o600 });
    await atomicWriteFile(change.file, change.after, { mode: 0o600 });
    const { record } = await stateFile(ctx, change.file);
    const saved = JSON.parse(await readFile(record, 'utf8')); saved.expected = change.after;
    await atomicWriteFile(record, JSON.stringify(saved), { mode: 0o600 });
  }
}
function removeHook(settings, event, ctx) {
  const list = settings?.hooks?.[event]; if (!Array.isArray(list)) return false;
  let changed = false;
  const kept = [];
  for (const group of list) {
    if (!group || !Array.isArray(group.hooks)) { kept.push(group); continue; }
    const hooks = group.hooks.filter(hook => !(hook?.type === 'command' && hook.command?.includes(ctx.shimPath) && hook.command.includes(` hook claude-code ${event}`)));
    const ownedRemoved = hooks.length !== group.hooks.length;
    if (ownedRemoved) changed = true;
    if (hooks.length || !ownedRemoved) kept.push(ownedRemoved ? { ...group, hooks } : group);
  }
  if (changed) { if (kept.length) settings.hooks[event] = kept; else delete settings.hooks[event]; }
  return changed;
}
export async function remove(ctx) {
  const files = filesOf(ctx); const targets = [files.mcp, files.settings, files.instructions];
  for (const file of targets) {
    const { record } = await stateFile(ctx, file); const recText = await readOptional(record);
    const current = await readOptional(file);
    if (current === null) { if (recText !== null) await unlink(record); continue; }
    let original;
    if (recText) { try { original = JSON.parse(recText); } catch { fail('E_STATE_CORRUPT', 'Adapter state is invalid.'); } }
    if (original?.file === file && current === original.expected) {
      if (original.existed) await atomicWriteFile(file, original.original, { mode: 0o600 }); else await unlink(file);
      if (recText !== null) await unlink(record);
      continue;
    }
    if (file === files.instructions) {
      const block = managedBlock(current);
      if (!block) continue;
      const next = `${current.slice(0, block.start)}${current.slice(block.end)}`;
      await atomicWriteFile(file, next, { mode: 0o600 }); if (recText !== null) await unlink(record); continue;
    }
    const value = parseJson(current); let changed = false;
    if (file === files.mcp) {
      if (value.mcpServers && Object.hasOwn(value.mcpServers, 'brainatlas')) { delete value.mcpServers.brainatlas; if (!Object.keys(value.mcpServers).length) delete value.mcpServers; changed = true; }
    } else {
      changed = removeHook(value, 'UserPromptSubmit', ctx) || changed;
      changed = removeHook(value, 'SessionStart', ctx) || changed;
      if (value.hooks && !Object.keys(value.hooks).length) delete value.hooks;
    }
    if (changed) await atomicWriteFile(file, jsonStringify(value, current), { mode: 0o600 });
    if (recText !== null) await unlink(record);
  }
}
export async function doctor(ctx) {
  const files = filesOf(ctx); const checks = [];
  const mcpText = await readOptional(files.mcp); let registered = false;
  if (mcpText !== null) { const value = parseJson(mcpText); registered = value.mcpServers?.brainatlas?.command === ctx.nodePath && JSON.stringify(value.mcpServers.brainatlas.args) === JSON.stringify([ctx.shimPath, 'mcp']); }
  checks.push({ id: 'registered', ok: registered, message: registered ? 'BrainAtlas MCP server is registered.' : 'BrainAtlas MCP server is not registered.' });
  let shimExists = false;
  if (ctx.shimPath) { try { shimExists = (await stat(ctx.shimPath)).isFile(); } catch { shimExists = false; } }
  checks.push({ id: 'shim', ok: shimExists, message: shimExists ? 'Shim file exists.' : 'Shim file is missing.' });
  checks.push({ id: 'version-drift', ok: true, message: 'Version drift cannot be determined from adapter configuration.' });
  const settingsText = await readOptional(files.settings); let hookPresent = false;
  if (settingsText !== null) { const settings = parseJson(settingsText); hookPresent = ['UserPromptSubmit', 'SessionStart'].some(event => settings.hooks?.[event]?.some(group => group.hooks?.some(hook => hook.command?.includes(ctx.shimPath) && hook.command.includes(` hook claude-code ${event}`)))); }
  checks.push({ id: 'hook-present', ok: hookPresent, message: hookPresent ? 'Claude Code hooks are configured.' : 'Claude Code hooks are not configured.' });
  return { ok: checks.every(check => check.ok), checks };
}
export async function trustReview(_ctx) { // contract arity (docs/contracts/adapter.md)
  return { required: true, client: displayName, steps: ['Start a new Claude Code session.', 'Approve the BrainAtlas MCP server if prompted.'] };
}
