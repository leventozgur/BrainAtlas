// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adapterKit } from '../../packages/core/src/index.mjs';
import * as codex from '../../packages/adapters/codex/src/index.mjs';

function releaseSerialize(obj, before) {
  const indent = before?.match(/\n([ \t]+)"/)?.[1] || '  ';
  const trailing = before?.endsWith('\n') ? '\n' : '';
  return JSON.stringify(obj, null, indent) + trailing;
}

async function plannedHooks(hooksJson) {
  const base = await mkdtemp(join(tmpdir(), 'ba102-kit-'));
  const home = join(base, 'home');
  const vault = join(base, 'vault');
  await mkdir(join(home, '.codex'), { recursive: true });
  await mkdir(vault, { recursive: true });
  await writeFile(join(home, '.codex', 'hooks.json'), hooksJson);
  const ctx = {
    env: { HOME: home },
    platform: 'linux',
    config: { vault: { path: vault } },
    paths: { stateDir: join(base, 'state') },
    scope: 'global',
    nodePath: '/usr/bin/node',
    shimPath: '/opt/brainatlas/bin/brainatlas',
    now: new Date('2026-01-02T03:04:05.000Z'),
  };
  const change = codex.plan(ctx).changes.find((item) => item.file === join(home, '.codex', 'hooks.json'));
  return { change, hooksJson };
}

test('codex JSON output matches release-rc.19 for a root array', async () => {
  const { change, hooksJson } = await plannedHooks('[ "a",\n\t"b"\n]\n');
  const hooks = JSON.parse(change.after);
  assert.ok(Array.isArray(hooks));
  assert.equal(change.after, releaseSerialize(hooks, hooksJson));
  assert.equal(change.after, '[\n\t"a",\n\t"b"\n]\n');
});

test('codex JSON output matches release-rc.19 for an empty key', async () => {
  const { change, hooksJson } = await plannedHooks('{\n    "": 1\n}\n');
  assert.equal(change.after, releaseSerialize(JSON.parse(change.after), hooksJson));
  assert.match(change.after, /\n {4}"": 1/);
});

test('clearOriginal tolerates ENOENT and rethrows other errors', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ba102-clear-'));
  const file = join(dir, 'record.json');
  await writeFile(file, '{}');
  await adapterKit.clearOriginal(file);
  await adapterKit.clearOriginal(file);
  assert.equal(await adapterKit.readOptional(file), null);
  await assert.rejects(adapterKit.clearOriginal(dir), (error) => error.code !== 'ENOENT');
  await assert.rejects(adapterKit.clearOriginal(join(dir, 'missing', '\0bad')), (error) => error.code !== 'ENOENT');
  assert.equal(await readFile(join(dir, 'record.json'), 'utf8').catch((e) => e.code), 'ENOENT');
});
