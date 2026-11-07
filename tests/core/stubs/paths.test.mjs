// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePaths, vaultId } from '../../../packages/core/src/paths/index.mjs';

test('macOS path table uses injected HOME only', () => {
  assert.deepEqual(resolvePaths({ platform: 'darwin', env: { HOME: '/Users/you' } }), {
    dataDir: '/Users/you/Library/Application Support/BrainAtlas',
    releasesDir: '/Users/you/Library/Application Support/BrainAtlas/releases',
    currentDir: '/Users/you/Library/Application Support/BrainAtlas/current',
    binPath: '/Users/you/Library/Application Support/BrainAtlas/bin/brainatlas',
    configFile: '/Users/you/Library/Application Support/BrainAtlas/config.json',
    stateDir: '/Users/you/Library/Application Support/BrainAtlas/state',
    installManifest: '/Users/you/Library/Application Support/BrainAtlas/install-manifest.json'
  });
});

test('Linux path defaults and XDG overrides', () => {
  assert.deepEqual(resolvePaths({ platform: 'linux', env: { HOME: '/home/you' } }), {
    dataDir: '/home/you/.local/share/brainatlas', releasesDir: '/home/you/.local/share/brainatlas/releases', currentDir: '/home/you/.local/share/brainatlas/current',
    binPath: '/home/you/.local/share/brainatlas/bin/brainatlas', configFile: '/home/you/.config/brainatlas/config.json', stateDir: '/home/you/.local/state/brainatlas', installManifest: '/home/you/.local/share/brainatlas/install-manifest.json'
  });
  const custom = resolvePaths({ platform: 'linux', env: { HOME: '/home/you', XDG_DATA_HOME: '/data', XDG_CONFIG_HOME: '/config', XDG_STATE_HOME: '/state' } });
  assert.equal(custom.dataDir, '/data'); assert.equal(custom.configFile, '/config/brainatlas/config.json'); assert.equal(custom.stateDir, '/state/brainatlas');
});

test('paths require injected HOME and vault IDs are stable hashes', () => {
  assert.throws(() => resolvePaths({ platform: 'linux', env: {} }), { code: 'E_NO_HOME' });
  assert.equal(vaultId('/vault'), vaultId('/vault')); assert.match(vaultId('/vault'), /^[a-f0-9]{16}$/);
  assert.throws(() => vaultId('relative'), { code: 'E_VAULT_PATH' });
});
