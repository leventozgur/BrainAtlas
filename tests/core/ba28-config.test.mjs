// SPDX-License-Identifier: MIT
// BA-28: retrieval.shadow is an optional, single-key object with an abstainThreshold in [0, 1].
import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig, validateConfig } from '../../packages/core/src/config/index.mjs';

const withShadow = shadow => {
  const cfg = defaultConfig('lite');
  cfg.retrieval.shadow = shadow;
  return cfg;
};

test('retrieval.shadow is optional and no default value is written', () => {
  const cfg = defaultConfig('lite');
  assert.equal(Object.hasOwn(cfg.retrieval, 'shadow'), false);
  assert.equal(validateConfig(cfg).ok, true);
});

test('retrieval.shadow accepts one abstainThreshold from 0 to 1 inclusive', () => {
  for (const value of [0, 0.35, 0.5, 1]) assert.equal(validateConfig(withShadow({ abstainThreshold: value })).ok, true, String(value));
});

test('retrieval.shadow rejects missing, extra, non-numeric and out-of-range values', () => {
  for (const shadow of [{}, { abstainThreshold: 0.5, other: 1 }, { abstainThreshold: '0.5' }, { abstainThreshold: -0.1 }, { abstainThreshold: 1.1 }, { abstainThreshold: null }, [], null, 0.5]) {
    assert.equal(validateConfig(withShadow(shadow)).ok, false, JSON.stringify(shadow));
  }
});
