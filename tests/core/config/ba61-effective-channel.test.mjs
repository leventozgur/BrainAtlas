// SPDX-License-Identifier: MIT
// BA-61: effectiveChannel() and the optional `channels` schema key.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';

const root = process.env.HX_WT || resolve('.');
const core = await import(pathToFileURL(join(root, 'packages/core/src/index.mjs')).href);
const { effectiveChannel, defaultConfig, validateConfig } = core;

test('global channel applies without a channels map', () => {
  assert.equal(effectiveChannel({}, 'kiro'), 'mcp');
  assert.equal(effectiveChannel({ channel: 'cli' }, 'kiro'), 'cli');
  assert.equal(effectiveChannel({ channel: 'mcp' }, 'kiro'), 'mcp');
});

test('a per-agent entry wins over the global channel', () => {
  const config = { channel: 'cli', channels: { kiro: 'mcp', codex: 'cli' } };
  assert.equal(effectiveChannel(config, 'kiro'), 'mcp');
  assert.equal(effectiveChannel(config, 'codex'), 'cli');
  assert.equal(effectiveChannel(config, 'gemini-cli'), 'cli');
  assert.equal(effectiveChannel({ channels: { kiro: 'cli' } }, 'kiro'), 'cli');
  assert.equal(effectiveChannel({ channels: { kiro: 'cli' } }, 'codex'), 'mcp');
});

test('missing or odd configs never throw', () => {
  for (const config of [null, undefined, 5, 'x', [], { channels: null }, { channels: [] }, { channels: 'cli' }])
    assert.equal(effectiveChannel(config, 'kiro'), 'mcp');
  assert.equal(effectiveChannel({ channel: 'cli', channels: { kiro: 'bogus' } }, 'kiro'), 'cli');
});

test('inherited properties are not read', () => {
  for (const agent of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    assert.equal(effectiveChannel({ channels: {} }, agent), 'mcp');
    assert.equal(effectiveChannel({ channel: 'cli', channels: {} }, agent), 'cli');
  }
  const polluted = Object.create({ kiro: 'cli' });
  assert.equal(effectiveChannel({ channels: polluted }, 'kiro'), 'mcp');
});

test('schema accepts valid channels and rejects invalid ones', () => {
  const base = defaultConfig('lite');
  assert.equal('channels' in base, false);
  assert.equal(validateConfig(base).ok, true);
  assert.equal(validateConfig({ ...base, channels: {} }).ok, true);
  assert.equal(validateConfig({ ...base, channels: { kiro: 'cli', codex: 'mcp' } }).ok, true);
  assert.equal(validateConfig({ ...base, channels: { kiro: 'shell' } }).ok, false);
  assert.equal(validateConfig({ ...base, channels: { unknown: 'cli' } }).ok, false);
  assert.equal(validateConfig({ ...base, channels: 'cli' }).ok, false);
});
