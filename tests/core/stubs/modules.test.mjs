// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverModules, readModuleManifest, resolveModuleOrder, resolveProfileModules } from '../../../packages/core/src/modules/index.mjs';

test('fixture manifests are discovered and dependencies are ordered first', async () => {
  const release = new URL('../modules/fixtures/release/', import.meta.url).pathname;
  const manifests = await discoverModules(release);
  assert.deepEqual(manifests.map((item) => item.name), ['consumer', 'foundation']);
  assert.deepEqual(resolveModuleOrder(manifests).map((item) => item.name), ['foundation', 'consumer']);
});

test('profile module resolution expands the full wildcard in dependency order', async () => {
  const release = new URL('../modules/fixtures/release/', import.meta.url).pathname;
  const manifests = await discoverModules(release);
  assert.deepEqual(resolveProfileModules('lite', manifests), []);
  assert.deepEqual(resolveProfileModules('custom', manifests), []);
  assert.deepEqual(resolveProfileModules('full', manifests), ['foundation', 'consumer']);
});

test('invalid manifests include only the manifest file name in error details', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'brainatlas-module-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const moduleDir = join(dir, 'modules', 'broken'); await mkdir(moduleDir, { recursive: true });
  await writeFile(join(moduleDir, 'module.json'), JSON.stringify({ name: '../bad', version: '1', description: 'invalid', requires: [], provides: [], profiles: ['full'], entry: 'index.mjs' }));
  await assert.rejects(discoverModules(dir), (error) => error.code === 'E_MODULE_MANIFEST' && error.details.file === 'module.json');
  assert.throws(() => readModuleManifest(moduleDir), { code: 'E_MODULE_MANIFEST' });
});

test('missing dependencies and cycles report stable error codes', () => {
  const item = (name, requires) => ({ name, version: '1.0.0', description: 'fixture', requires, provides: [], profiles: ['full'], entry: 'index.mjs' });
  assert.throws(() => resolveModuleOrder([item('first', ['missing'])]), { code: 'E_MODULE_DEPENDENCY' });
  assert.throws(() => resolveModuleOrder([item('first', ['second']), item('second', ['first'])]), { code: 'E_MODULE_CYCLE' });
});
