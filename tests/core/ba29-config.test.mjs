// SPDX-License-Identifier: MIT
// BA-29: retrieval.exclude is an optional array of vault-relative glob patterns; absent means the default scope.
import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig, validateConfig } from '../../packages/core/src/config/index.mjs';

const withExclude = (exclude) => {
  const cfg = defaultConfig('lite');
  cfg.retrieval = { ...cfg.retrieval, exclude };
  return cfg;
};

test('retrieval.exclude accepts an array of relative glob patterns and the empty list', () => {
  assert.equal(validateConfig(withExclude(['index.md', 'planning/**'])).ok, true);
  assert.equal(validateConfig(withExclude([])).ok, true);
});

test('retrieval.exclude must be an array of non-empty strings', () => {
  assert.equal(validateConfig(withExclude('index.md')).ok, false);
  assert.equal(validateConfig(withExclude([''])).ok, false);
  assert.equal(validateConfig(withExclude([42])).ok, false);
});

test('retrieval.exclude rejects absolute, parent-relative and backslash patterns', () => {
  for (const bad of ['/etc/x.md', '../x.md', 'notes/../../x.md', 'notes\\x.md', 'C:/x.md']) {
    const result = validateConfig(withExclude([bad]));
    assert.equal(result.ok, false, bad);
    assert.equal(result.errors[0].path, 'retrieval.exclude[0]', bad);
  }
});

test('a configuration without retrieval.exclude stays valid and keeps the default shape', () => {
  const cfg = defaultConfig('lite');
  assert.equal(Object.hasOwn(cfg.retrieval, 'exclude'), false);
  assert.equal(validateConfig(cfg).ok, true);
});
