// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defaultConfig,
  loadConfig,
  readStandard,
  STANDARD_VERSION,
  writeStandard,
} from '../../packages/core/src/index.mjs';
import { inventoryVault } from '../../modules/sync-engine/src/scope.mjs';

const standard = {
  standardVersion: STANDARD_VERSION,
  okf: { level: 'strict' },
  retrieval: { budgetChars: 1234, abstainThreshold: 0.5, exclude: ['drafts/**'] },
  safety: { extraDenyGlobs: ['private/**'] },
  capabilities: { minimum: { read: true, write: false } },
};

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'ba95-standard-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const vault = join(base, 'vault');
  await mkdir(vault, { recursive: true });
  const configFor = async (name, mutate = () => {}) => {
    const cfg = defaultConfig('lite');
    cfg.vault.path = vault;
    mutate(cfg);
    const file = join(base, `${name}.json`);
    await writeFile(file, `${JSON.stringify(cfg, null, 2)}\n`);
    return file;
  };
  return { base, vault, configFor };
}

test('readStandard and writeStandard round-trip a vault standard and refuse symlinks', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await readStandard(f.vault), { standard: null, errors: [] });
  await writeStandard(f.vault, standard);
  assert.deepEqual(await readStandard(f.vault), { standard, errors: [] });

  const invalid = join(f.base, 'invalid');
  await mkdir(join(invalid, '.brainatlas'), { recursive: true });
  await writeFile(join(invalid, '.brainatlas', 'standard.json'), '{');
  const parsed = await readStandard(invalid);
  assert.equal(parsed.standard, null);
  assert.equal(parsed.errors[0].code, 'E_STANDARD_PARSE');
  assert.ok((await readStandard(join(invalid, '.brainatlas', 'standard.json'))).errors.length > 0);

  const outside = join(f.base, 'outside');
  await mkdir(outside, { recursive: true });
  const linked = join(f.base, 'linked');
  await mkdir(linked, { recursive: true });
  await symlink(outside, join(linked, '.brainatlas'));
  await assert.rejects(writeStandard(linked, standard), { code: 'E_STANDARD_SYMLINK' });
  assert.equal((await readStandard(linked)).errors[0].code, 'E_STANDARD_SYMLINK');
});

test('a valid vault standard overrides only the vault-scoped keys on every device', async (t) => {
  const f = await fixture(t);
  await writeStandard(f.vault, standard);
  const first = await f.configFor('first', (cfg) => {
    cfg.okf.level = 'warn';
    cfg.retrieval.budgetChars = 4000;
    cfg.retrieval.abstainThreshold = 0.35;
    cfg.retrieval.exclude = ['device-only/**'];
    cfg.safety.extraDenyGlobs = ['device/**'];
    cfg.retrieval.pullLowConfidence = false;
  });
  const second = await f.configFor('second', (cfg) => {
    cfg.okf.level = 'strict';
    cfg.retrieval.budgetChars = 9999;
    cfg.retrieval.abstainThreshold = 0.1;
    cfg.safety.extraDenyGlobs = [];
    cfg.hooks.mode = 'manual';
  });
  for (const file of [first, second]) {
    const loaded = await loadConfig({ paths: { configFile: file }, env: {} });
    assert.equal(loaded.standardApplied, true);
    assert.equal(loaded.okf.level, 'strict');
    assert.equal(loaded.retrieval.budgetChars, 1234);
    assert.equal(loaded.retrieval.abstainThreshold, 0.5);
    assert.deepEqual(loaded.retrieval.exclude, ['drafts/**']);
    assert.deepEqual(loaded.safety.extraDenyGlobs, ['private/**']);
  }
  const loadedFirst = await loadConfig({ paths: { configFile: first }, env: {} });
  assert.equal(loadedFirst.retrieval.pullLowConfidence, false);
  const loadedSecond = await loadConfig({ paths: { configFile: second }, env: {} });
  assert.equal(loadedSecond.hooks.mode, 'manual');
});

test('missing, invalid and newer standards leave the device values in effect', async (t) => {
  const f = await fixture(t);
  const file = await f.configFor('device', (cfg) => {
    cfg.okf.level = 'warn';
    cfg.retrieval.budgetChars = 4321;
    cfg.retrieval.abstainThreshold = 0.2;
    cfg.safety.extraDenyGlobs = ['device/**'];
  });
  const missing = await loadConfig({ paths: { configFile: file }, env: {} });
  assert.equal(missing.standardApplied, false);
  assert.equal(missing.retrieval.budgetChars, 4321);

  await mkdir(join(f.vault, '.brainatlas'), { recursive: true });
  await writeFile(join(f.vault, '.brainatlas', 'standard.json'), '{');
  const invalid = await loadConfig({ paths: { configFile: file }, env: {} });
  assert.equal(invalid.standardApplied, false);
  assert.equal(invalid.okf.level, 'warn');
  assert.equal(invalid.retrieval.budgetChars, 4321);

  await writeFile(
    join(f.vault, '.brainatlas', 'standard.json'),
    `${JSON.stringify({ ...standard, standardVersion: STANDARD_VERSION + 1 })}\n`
  );
  const newer = await loadConfig({ paths: { configFile: file }, env: {} });
  assert.equal(newer.standardApplied, false);
  assert.equal(newer.okf.level, 'warn');
  assert.equal(newer.retrieval.abstainThreshold, 0.2);
  assert.deepEqual(newer.safety.extraDenyGlobs, ['device/**']);
});

test('the sync inventory always includes the vault standard file', async (t) => {
  const f = await fixture(t);
  await writeStandard(f.vault, standard);
  await mkdir(join(f.vault, 'wiki'), { recursive: true });
  await writeFile(join(f.vault, 'wiki', 'page.md'), '# Page\n');
  const inventory = await inventoryVault({
    vaultPath: f.vault,
    config: { sync: { options: { include: ['**/*.md'] } } },
  });
  assert.equal(inventory.files.has('.brainatlas/standard.json'), true);
  assert.equal(inventory.files.has('wiki/page.md'), true);
});
