// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { packageRootFromUrl } from '@brainatlas/core';

test('installed copy resolves to the directory containing node_modules', () => {
  assert.equal(packageRootFromUrl('file:///opt/r/node_modules/@brainatlas/hooks/src/semantic.mjs'), '/opt/r');
});

test('workspace layout resolves to the directory containing packages', () => {
  assert.equal(packageRootFromUrl('file:///repo/packages/hooks/src/semantic.mjs'), '/repo');
});

test('the last occurrence of either pattern wins', () => {
  assert.equal(
    packageRootFromUrl('file:///a/packages/x/node_modules/@brainatlas/core/src/vault/index.mjs'),
    '/a/packages/x'
  );
  assert.equal(
    packageRootFromUrl('file:///a/node_modules/@brainatlas/core/packages/hooks/src/x.mjs'),
    '/a/node_modules/@brainatlas/core'
  );
});

test('URL objects are accepted and no trailing separator is returned', () => {
  const url = pathToFileURL('/opt/r/node_modules/@brainatlas/core/src/index.mjs');
  assert.equal(packageRootFromUrl(url), '/opt/r');
  assert.equal(packageRootFromUrl('file:///packages/core/src/index.mjs'), '/');
});

test('unrelated paths and invalid inputs throw E_PACKAGE_ROOT', () => {
  for (const input of [
    'file:///tmp/other/file.mjs',
    'file:///tmp/packages/core',
    'https://example.com/packages/core/x.mjs',
    'not a url',
    42,
    null,
    undefined,
  ]) {
    assert.throws(() => packageRootFromUrl(input), { code: 'E_PACKAGE_ROOT' }, String(input));
  }
});
