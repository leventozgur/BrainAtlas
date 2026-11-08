// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readModuleManifest } from '../../packages/core/src/modules/index.mjs';
import { activate, check, checkCommand, commands, lintGate } from '../../modules/okf-strict/src/index.mjs';

async function vault(t) {
  const dir = await mkdtemp(join(tmpdir(), 'ba-okf-strict-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'wiki'), { recursive: true });
  return dir;
}

async function page(dir, name, frontmatter, body = 'private page body') {
  const file = join(dir, 'wiki', name);
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, `---\n${frontmatter}\n---\n${body}\n`);
}

test('module manifest follows the module contract and activation accepts a context', async () => {
  const manifest = readModuleManifest(resolve('modules/okf-strict'));
  assert.equal(manifest.name, 'okf-strict');
  assert.deepEqual(manifest.requires, []);
  assert.deepEqual(manifest.provides, ['okf-strict']);
  assert.deepEqual(manifest.profiles, ['full', 'custom']);
  await activate({});
  assert.equal(typeof commands.check, 'function');
});

test('strict mode rejects unverified confirmed pages, date-only generated values, malformed stale_after, and invalid targets', async (t) => {
  const dir = await vault(t);
  await page(dir, 'target.md', 'generated: "2026-01-01T00:00:00Z"\nstatus: superseded\nsources: []\nverified: []\nstale_after: P2W\nsuperseded_by: wiki/other.md');
  await page(dir, 'bad.md', 'generated: "2026-01-01"\nstatus: confirmed\nsources: [source-a]\nverified: [{date: "2026-01-01", evidence: observed, scope: narrow, source: unlisted}]\nstale_after: soon');
  await page(dir, 'old.md', 'generated: "2026-01-01T00:00:00Z"\nstatus: superseded\nsources: []\nverified: []\nstale_after: P2W\nsuperseded_by: wiki/target.md');
  const results = await check(dir, { asOf: new Date('2026-02-01T00:00:00Z') });
  const rules = results.filter((item) => item.path === 'wiki/bad.md').map((item) => item.rule);
  for (const rule of ['confirmed.unverified', 'generated.timestamp-required', 'stale_after.invalid']) assert.ok(rules.includes(rule), rule);
  assert.ok(results.some((item) => item.path === 'wiki/old.md' && item.rule === 'superseded.target-invalid'));
  assert.ok(results.filter((item) => item.path === 'wiki/bad.md' && ['confirmed.unverified', 'generated.timestamp-required', 'stale_after.invalid'].includes(item.rule)).every((item) => item.severity === 'error'));
  assert.equal(JSON.stringify(results).includes('private page body'), false);
});

test('strict mode exempts structural index and log files like core checkVault', async (t) => {
  const dir = await vault(t);
  await writeFile(join(dir, 'wiki/index.md'), '# Wiki index\n\n- [Page](wiki/page.md)\n');
  await writeFile(join(dir, 'wiki/log.md'), '# Wiki log\n\n- Recent activity\n');
  assert.deepEqual(await check(dir, { asOf: new Date('2026-01-03T00:00:00Z') }), []);
});

test('a scoped verification source and a non-superseded target pass strict checks', async (t) => {
  const dir = await vault(t);
  await page(dir, 'current.md', 'generated: "2026-01-01T00:00:00Z"\nstatus: confirmed\nsources: [source-a]\nverified: [{date: "2026-01-02", evidence: "checked release notes", scope: "api behavior", source: source-a}]\nstale_after: P4W');
  await page(dir, 'old.md', 'generated: "2026-01-01T00:00:00Z"\nstatus: superseded\nsources: []\nverified: []\nstale_after: P4W\nsuperseded_by: wiki/current.md');
  const results = await check(dir, { asOf: new Date('2026-01-03T00:00:00Z') });
  assert.equal(results.some((item) => item.severity === 'error'), false);
});

test('--changed narrows output while targets are resolved against the full vault', async (t) => {
  const dir = await vault(t);
  await page(dir, 'bad.md', 'generated: "2026-01-01"\nstatus: confirmed\nsources: []\nverified: []\nstale_after: invalid');
  await page(dir, 'good.md', 'generated: "2026-01-01T00:00:00Z"\nstatus: proposed\nsources: []\nverified: []\nstale_after: P2W');
  const results = await check(dir, { changed: ['wiki/good.md'], asOf: new Date('2026-01-02T00:00:00Z') });
  assert.ok(results.every((item) => item.path === 'wiki/good.md'));
  const gate = await lintGate(dir, ['wiki/bad.md'], { asOf: new Date('2026-01-02T00:00:00Z') });
  assert.equal(gate.ok, false);
  assert.ok(gate.errorCount > 0);
});

test('command parses strict, changed, as-of, and json options and reports an exit code', async (t) => {
  const dir = await vault(t);
  await page(dir, 'page.md', 'generated: "2026-01-01T00:00:00Z"\nstatus: proposed\nsources: []\nverified: []\nstale_after: P2W');
  const result = await checkCommand({ vaultDir: dir }, ['--strict', '--changed', 'wiki/page.md', '--as-of', '2026-01-02', '--json']);
  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.json, true);
  await assert.rejects(checkCommand({ vaultDir: dir }, ['--strict', '--changed', '../outside.md']), TypeError);
  await assert.rejects(checkCommand({ vaultDir: dir }, ['--as-of', 'not-a-date']), TypeError);
});

test('generic okf command returns JSON findings and an error exit code', async (t) => {
  const dir = await vault(t);
  await page(dir, 'bad.md', 'generated: "2026-01-01"\nstatus: confirmed\nsources: []\nverified: []\nstale_after: P2W');
  const result = await commands.okf(['check', '--strict', '--json'], { vaultDir: dir });
  assert.equal(result.exitCode, 1);
  const output = JSON.parse(result.output);
  assert.ok(output.findings.some((item) => item.path === 'wiki/bad.md' && item.rule === 'confirmed.unverified'));
});
