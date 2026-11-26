// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { checkRule } from '../../scripts/guard-lib.mjs';
const fixtureRoot = resolve(new URL('./fixtures', import.meta.url).pathname);
for (const rule of ['abs-path', 'lite-purity', 'forbidden-api', 'license-header', 'lockfile']) {
  test(`${rule} guard catches bad fixture and accepts good fixture`, async () => {
    const temp = await mkdtemp(join(tmpdir(), 'ba-guard-'));
    try {
      const bad = join(temp, 'bad');
      await cp(join(fixtureRoot, rule, 'bad'), bad, { recursive: true });
      const good = join(temp, 'good');
      await cp(join(fixtureRoot, rule, 'good'), good, { recursive: true });
      assert.ok((await checkRule(bad, rule)).length > 0, 'bad fixture must be reported');
      assert.deepEqual(await checkRule(good, rule), []);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
}

const rootPackage = (extra = {}) => ({ name: 'fixture', version: '1.0.0', ...extra });
async function syntheticRepo(root, locked) {
  const dir = await mkdtemp(join(tmpdir(), 'ba-guard-dev-'));
  const pkg = rootPackage(root);
  await writeFile(join(dir, 'package.json'), JSON.stringify(pkg));
  await writeFile(
    join(dir, 'package-lock.json'),
    JSON.stringify({
      name: 'fixture',
      version: '1.0.0',
      lockfileVersion: 3,
      requires: true,
      packages: { '': pkg, ...locked },
    })
  );
  return dir;
}
for (const [name, root, locked, expected] of [
  [
    'a dev root and its dev transitive dependency pass',
    { devDependencies: { eslint: '10.0.0' } },
    {
      'node_modules/eslint': { version: '10.0.0', dev: true, dependencies: { espree: '10.0.0' } },
      'node_modules/espree': { version: '10.0.0', dev: true },
    },
    [],
  ],
  [
    'an unlisted root devDependency fails',
    { devDependencies: { '@brainatlas/core': '*' } },
    {
      'node_modules/@brainatlas/core': { resolved: 'packages/core', link: true },
      'packages/core': { name: '@brainatlas/core', version: '0.0.0' },
    },
    ['package.json'],
  ],
  [
    'a dev package not reachable from a dev root fails',
    { devDependencies: { eslint: '10.0.0' } },
    {
      'node_modules/eslint': { version: '10.0.0', dev: true },
      'node_modules/left-pad': { version: '1.0.0', dev: true },
    },
    ['package-lock.json'],
  ],
  [
    'a runtime package reachable only from a dev root fails',
    { devDependencies: { eslint: '10.0.0' } },
    {
      'node_modules/eslint': { version: '10.0.0', dev: true, dependencies: { chalk: '5.0.0' } },
      'node_modules/chalk': { version: '5.0.0' },
    },
    ['package-lock.json'],
  ],
]) {
  test(`lockfile guard: ${name}`, async () => {
    const dir = await syntheticRepo(root, locked);
    try {
      const findings = await checkRule(dir, 'lockfile');
      assert.deepEqual(
        findings.map((finding) => finding.file),
        expected
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}
