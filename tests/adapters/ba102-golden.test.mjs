// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, relative, resolve } from 'node:path';
import * as claudeCode from '../../packages/adapters/claude-code/src/index.mjs';
import * as codex from '../../packages/adapters/codex/src/index.mjs';
import * as geminiCli from '../../packages/adapters/gemini-cli/src/index.mjs';
import * as kiro from '../../packages/adapters/kiro/src/index.mjs';
import * as copilot from '../../packages/adapters/copilot-vscode/src/index.mjs';

const GOLDEN = resolve('tests/adapters/ba102-golden');
const fixtures = {
  codex: resolve('tests/adapters/codex/fixtures/existing'),
  kiro: resolve('tests/adapters/kiro/fixtures/existing'),
  copilot: resolve('tests/adapters/copilot-vscode/fixtures/existing'),
};
const shimPath = '/opt/brainatlas/bin/brainatlas';

async function snapshot(root) {
  const result = {};
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) result[relative(root, full).split('\\').join('/')] = await readFile(full);
    }
  }
  await walk(root);
  return result;
}

async function writeFiles(root, files) {
  for (const [name, bytes] of Object.entries(files)) {
    const file = join(root, name);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, bytes);
  }
}

async function assertGolden(agent, home, report) {
  const actual = await snapshot(home);
  const expectedDir = join(GOLDEN, agent);
  const expected = await snapshot(expectedDir);
  delete expected['doctor.json'];
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort());
  for (const name of Object.keys(expected)) assert.deepEqual(actual[name], expected[name], name);
  assert.deepEqual(JSON.parse(await readFile(join(expectedDir, 'doctor.json'), 'utf8')), report);
}

async function setup(name, seed) {
  const base = await mkdtemp(join(tmpdir(), 'ba102-golden-'));
  const home = join(base, 'home');
  const state = join(base, 'state');
  const vault = join(base, 'vault');
  await mkdir(home, { recursive: true });
  await mkdir(vault, { recursive: true });
  const source = fixtures[name];
  if (source) await cp(source, home, { recursive: true });
  if (seed) await writeFiles(home, seed);
  return { base, home, state, vault, shimPath };
}

test('claude-code golden output', async () => {
  const { home, state } = await setup();
  const fixture = resolve('tests/adapters/claude-code/fixtures/existing');
  await mkdir(join(home, '.claude'), { recursive: true });
  await cp(join(fixture, '.claude.json'), join(home, '.claude.json'));
  await cp(join(fixture, 'settings.json'), join(home, '.claude', 'settings.json'));
  await cp(join(fixture, 'CLAUDE.md'), join(home, 'CLAUDE.md'));
  const ctx = {
    env: { HOME: home, XDG_STATE_HOME: state },
    platform: 'linux',
    scope: 'global',
    nodePath: '/opt/node with spaces/node',
    shimPath,
    now: new Date('2026-11-08T10:11:12.000Z'),
  };
  await claudeCode.apply(claudeCode.plan(ctx), ctx);
  await assertGolden('claude-code', home, await claudeCode.doctor(ctx));
});

test('codex golden output', async () => {
  const { home, state, vault, shimPath } = await setup('codex');
  const ctx = {
    env: { HOME: home },
    platform: 'linux',
    config: { vault: { path: vault } },
    paths: { stateDir: state },
    scope: 'global',
    nodePath: '/usr/bin/node',
    shimPath,
    now: new Date('2026-01-02T03:04:05.000Z'),
  };
  await codex.apply(codex.plan(ctx), ctx);
  await assertGolden('codex', home, await codex.doctor(ctx));
});

test('gemini-cli golden output', async () => {
  const { home, state, shimPath } = await setup('geminiCli', {
    '.gemini/settings.json': '{\n    "other": {"keep": true},\n    "mcpServers": {"other": {"command": "x"}}\n}\n',
    'GEMINI.md': '# User instructions\r\nKeep this.\r\n',
  });
  const ctx = {
    env: { HOME: home, XDG_STATE_HOME: state },
    platform: 'linux',
    scope: 'global',
    nodePath: '/opt/node',
    shimPath,
    now: new Date('2026-01-02T03:04:05Z'),
  };
  await geminiCli.apply(geminiCli.plan(ctx), ctx);
  await assertGolden('gemini-cli', home, await geminiCli.doctor(ctx));
});

test('kiro golden output', async () => {
  const { home, state, shimPath } = await setup('kiro');
  const ctx = {
    env: { HOME: home },
    platform: 'linux',
    config: { vault: { path: home } },
    scope: 'global',
    nodePath: '/path with spaces/node',
    shimPath,
    paths: { stateDir: state },
    now: new Date('2026-11-08T12:00:00Z'),
  };
  await kiro.apply(await kiro.plan(ctx), ctx);
  await assertGolden('kiro', home, await kiro.doctor(ctx));
});

test('copilot-vscode golden output', async () => {
  const { home, state, vault, shimPath } = await setup('copilot');
  const ctx = {
    env: { HOME: home, BRAINATLAS_PLATFORM: 'linux' },
    platform: 'linux',
    scope: 'global',
    config: { vault: { path: vault }, agents: { copilot: {} } },
    paths: { stateDir: state, vault },
    nodePath: '/usr/bin/node',
    shimPath,
    now: new Date('2026-11-08T12:00:00.000Z'),
  };
  await copilot.apply(copilot.plan(ctx), ctx);
  await assertGolden('copilot-vscode', home, await copilot.doctor(ctx));
});
