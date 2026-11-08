// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { defaultConfig, resolvePaths } from '@brainatlas/core';
import { cleanEnv } from './clean-env.mjs';

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('routes commands to installed and enabled module exports', async t => {
  const home = await mkdtemp(join(tmpdir(), 'ba module route-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = cleanEnv({
    PATH: process.env.PATH || '/usr/bin:/bin',
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    BRAINATLAS_PLATFORM: 'linux',
    BRAINATLAS_OFFLINE: '1'
  });
  const paths = resolvePaths({ platform: 'linux', env });
  const releaseDir = join(paths.releasesDir, 'fixture-1');
  const moduleDir = join(releaseDir, 'modules', 'okf-fixture');
  const engineDir = join(releaseDir, 'modules', 'sync-engine');
  const transportDir = join(releaseDir, 'modules', 'transport-fixture');
  await mkdir(join(moduleDir, 'src'), { recursive: true });
  await mkdir(join(engineDir, 'src'), { recursive: true });
  await mkdir(join(transportDir, 'src'), { recursive: true });
  await mkdir(dirname(paths.configFile), { recursive: true });
  await writeFile(join(moduleDir, 'module.json'), `${JSON.stringify({
    name: 'okf-fixture', version: '1.0.0', description: 'CLI routing fixture', requires: [], provides: [], profiles: ['full'], entry: 'src/index.mjs'
  }, null, 2)}\n`);
  await writeFile(join(moduleDir, 'src/index.mjs'), `// SPDX-License-Identifier: MIT\nlet activated = false;\nexport async function activate(ctx) { if (!ctx.config.modules.includes('okf-fixture')) throw new Error('module is not enabled'); activated = true; (ctx.activationLog ||= []).push('okf-fixture'); }\nexport const commands = { okf(args, ctx) { return { args, activated, enabled: ctx.config.modules.includes('okf-fixture'), hasCore: typeof ctx.core.redact === 'function', hasLogger: typeof ctx.logger.info === 'function' }; } };\n`);
  await writeFile(join(engineDir, 'module.json'), `${JSON.stringify({
    name: 'sync-engine', version: '1.0.0', description: 'Sync engine fixture', requires: [], provides: ['sync'], profiles: ['full'], entry: 'src/index.mjs'
  }, null, 2)}\n`);
  await writeFile(join(engineDir, 'src/index.mjs'), `// SPDX-License-Identifier: MIT\nexport async function activate(ctx) { (ctx.activationLog ||= []).push('sync-engine'); }\nexport const commands = { sync() { return { route: 'engine' }; } };\n`);
  await writeFile(join(transportDir, 'module.json'), `${JSON.stringify({
    name: 'transport-fixture', version: '1.0.0', description: 'Transport fixture', requires: ['sync-engine'], provides: ['sync-transport:wire'], profiles: ['full'], entry: 'src/index.mjs'
  }, null, 2)}\n`);
  await writeFile(join(transportDir, 'src/index.mjs'), `// SPDX-License-Identifier: MIT\nexport async function activate(ctx) { (ctx.activationLog ||= []).push('transport-fixture'); ctx.transport = { active: true }; }\nexport const commands = { status(args, ctx) { return { route: 'transport', args, active: ctx.transport.active, activationLog: ctx.activationLog, registryReady: ctx.registry.has('transport-fixture') }; } };\n`);
  await symlink('releases/fixture-1', paths.currentDir);
  const cfg = defaultConfig('lite');
  cfg.modules = ['okf-fixture', 'sync-engine', 'transport-fixture'];
  await writeFile(paths.configFile, `${JSON.stringify(cfg, null, 2)}\n`);

  const cli = join(sourceRoot, 'packages/cli/bin/brainatlas.mjs');
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd: sourceRoot, env, encoding: 'utf8', shell: false });
  const routed = run('okf', 'check', '--strict');
  assert.equal(routed.status, 0, routed.stderr);
  assert.deepEqual(JSON.parse(routed.stdout), {
    args: ['check', '--strict'], activated: true, enabled: true, hasCore: true, hasLogger: true
  });

  const help = run('--help', '--json'); assert.equal(help.status, 0, help.stderr);
  const helpCommands = JSON.parse(help.stdout).commands;
  assert.ok(helpCommands.some(item => item.name === 'okf' && item.kind === 'module' && item.module === 'okf-fixture'));
  assert.ok(helpCommands.some(item => item.name === 'sync' && item.kind === 'module' && item.module === 'sync-engine'));
  const moduleHelp = run('help', 'okf', '--json'); assert.equal(moduleHelp.status, 0, moduleHelp.stderr);
  assert.equal(JSON.parse(moduleHelp.stdout).module, 'okf-fixture');

  const transportRouted = run('sync', 'wire', 'status', '--json');
  assert.equal(transportRouted.status, 0, transportRouted.stderr);
  assert.deepEqual(JSON.parse(transportRouted.stdout), {
    route: 'transport', args: ['--json'], active: true,
    activationLog: ['okf-fixture', 'sync-engine', 'transport-fixture'], registryReady: true
  });

  const unavailable = run('review', 'list');
  assert.equal(unavailable.status, 2);
  assert.match(unavailable.stderr, /E_COMMAND_UNKNOWN/);
  cfg.modules = [];
  await writeFile(paths.configFile, `${JSON.stringify(cfg, null, 2)}\n`);
  const inactive = run('okf', 'check');
  assert.equal(inactive.status, 2);
  assert.match(inactive.stderr, /E_COMMAND_UNKNOWN/);
});
