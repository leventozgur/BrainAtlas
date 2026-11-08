// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { defaultConfig } from '@brainatlas/core';
import { cleanEnv } from './clean-env.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const cli = join(root, 'packages/cli/bin/brainatlas.mjs');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

async function snapshotTree(base) {
  const result = new Map();
  async function visit(dir, rel = '') {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name); const path = rel ? `${rel}/${entry.name}` : entry.name; const stat = await lstat(file);
      if (stat.isDirectory() && !stat.isSymbolicLink()) await visit(file, path);
      else result.set(path, { sha256: sha(await readFile(file)), mtimeMs: stat.mtimeMs });
    }
  }
  await visit(base); return result;
}

function run(env, ...args) { return spawnSync(process.execPath, [cli, ...args], { cwd: root, env, encoding: 'utf8', shell: false }); }

test('adopt plan detects MCP servers, prompt hooks and vaults without writing', async t => {
  const home = await mkdtemp(join(tmpdir(), 'ba adopt fake home-')); t.after(() => rm(home, { recursive: true, force: true }));
  const vault = join(home, 'Documents', 'legacy vault'); await mkdir(join(vault, 'wiki'), { recursive: true });
  await writeFile(join(vault, 'wiki', 'index.md'), '# Existing index\n');
  await mkdir(join(home, '.claude')); await writeFile(join(home, '.claude.json'), JSON.stringify({ mcpServers: { 'second-brain': { command: 'node', args: ['old-mcp'] } } }));
  await writeFile(join(home, '.claude', 'settings.json'), JSON.stringify({
    hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'old prompt hook' }] }] }
  }));
  await mkdir(join(home, '.codex')); await writeFile(join(home, '.codex', 'config.toml'), '[mcp_servers.knowledge]\ncommand = "old-tool"\nargs = ["wiki_query"]\n');
  const env = cleanEnv({ HOME: home, PATH: process.env.PATH || '/usr/bin:/bin', BRAINATLAS_OFFLINE: '1' }); const before = await snapshotTree(home);
  const result = run(env, 'adopt', '--plan', '--json');
  assert.equal(result.status, 0, result.stderr); const report = JSON.parse(result.stdout);
  assert.deepEqual(report.vaultCandidates, [vault]);
  assert.ok(report.existingMcpServers.some(item => item.path === join(home, '.claude.json') && item.servers.includes('second-brain')));
  assert.ok(report.existingMcpServers.some(item => item.path === join(home, '.codex', 'config.toml') && item.servers.includes('wiki_query provider')));
  assert.ok(report.promptHooks.some(item => item.path === join(home, '.claude', 'settings.json')));
  assert.equal(report.recommendedConfig.profile, 'lite');
  assert.deepEqual(report.recommendedConfig.modules, defaultConfig('lite').modules);
  assert.equal(report.migration.from, vault); assert.equal(report.migration.to, join(home, 'BrainAtlas')); assert.equal(report.migration.targetEmpty, true);
  assert.deepEqual(await snapshotTree(home), before);
  const noPlan = run(env, 'adopt', '--json'); assert.equal(noPlan.status, 1); assert.match(noPlan.stderr, /E_ARGUMENT/);
});

test('help lists built-ins and reports unknown help topics as unknown commands', async t => {
  const home = await mkdtemp(join(tmpdir(), 'ba help fake home-')); t.after(() => rm(home, { recursive: true, force: true }));
  const env = cleanEnv({ HOME: home, PATH: process.env.PATH || '/usr/bin:/bin', BRAINATLAS_OFFLINE: '1' });
  const all = run(env, '--help', '--json'); assert.equal(all.status, 0, all.stderr);
  const names = JSON.parse(all.stdout).commands.map(item => item.name);
  for (const command of ['migrate', 'adopt', 'help', 'init', 'status']) assert.ok(names.includes(command));
  const detail = run(env, 'help', 'migrate', '--json'); assert.equal(detail.status, 0, detail.stderr); assert.equal(JSON.parse(detail.stdout).name, 'migrate');
  const unknown = run(env, 'help', 'not-a-command'); assert.equal(unknown.status, 2); assert.match(unknown.stderr, /E_COMMAND_UNKNOWN/);
});
