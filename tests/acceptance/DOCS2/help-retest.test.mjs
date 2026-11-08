// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, cpSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { defaultConfig } from '@brainatlas/core';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const cli = join(root, 'packages/cli/bin/brainatlas.mjs');
test('sync help reports exact installed commands and unavailable state', () => {
  const home = mkdtempSync(join(tmpdir(), 'docs2-retest-'));
  try {
    const env = { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: join(home, 'config'), XDG_DATA_HOME: join(home, 'data'), XDG_STATE_HOME: join(home, 'state'), BRAINATLAS_PLATFORM: 'linux', BRAINATLAS_OFFLINE: '1', NO_COLOR: '1' };
    const run = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd: home, env, encoding: 'utf8', timeout: 10000 });
    const absent = run('help', 'sync');
    assert.equal(absent.status, 0, absent.stderr);
    assert.match(absent.stdout, /install\/enable sync-engine/);
    assert.doesNotMatch(absent.stdout, /brainatlas sync run/);
    const data = join(home, 'data', 'brainatlas');
    const release = join(data, 'releases', 'fixture-1');
    mkdirSync(join(release, 'modules'), { recursive: true });
    for (const name of ['sync-engine', 'sync-git']) cpSync(join(root, 'modules', name), join(release, 'modules', name), { recursive: true });
    mkdirSync(join(release, 'packages'), { recursive: true });
    cpSync(join(root, 'packages/core'), join(release, 'packages/core'), { recursive: true });
    symlinkSync(join(root, 'node_modules'), join(release, 'node_modules'));
    symlinkSync('releases/fixture-1', join(data, 'current'));
    const configDir = join(home, 'config', 'brainatlas');
    mkdirSync(configDir, { recursive: true });
    const cfg = defaultConfig('lite'); cfg.modules = ['sync-engine', 'sync-git'];
    writeFileSync(join(configDir, 'config.json'), JSON.stringify(cfg));
    const installed = run('help', 'sync');
    assert.equal(installed.status, 0, installed.stderr);
    const doc = readFileSync(join(root, 'docs/user/sync.md'), 'utf8');
    const expected = ['brainatlas sync run [--json]', 'brainatlas sync status [--json]', 'brainatlas sync check --peer STATE_DIR [--json]', 'brainatlas sync approve <path> | --all', 'brainatlas sync pause', 'brainatlas sync resume', 'brainatlas sync git status [--json]'];
    for (const line of expected) { assert(installed.stdout.includes(line), `help missing ${line}`); assert(doc.includes(line), `documentation missing ${line}`); }
    assert.doesNotMatch(installed.stdout, /brainatlas sync \[ARGS\]/);
    cfg.modules = []; writeFileSync(join(configDir, 'config.json'), JSON.stringify(cfg));
    assert.match(run('help', 'sync').stdout, /install\/enable sync-engine/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
