// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, cp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { checkPage, checkVault } from '../../../packages/core/src/okf/index.mjs';
import { parseFrontmatter } from '../../../packages/core/src/vault/index.mjs';

test('checkPage validates local metadata and emits body-free warn/error findings', () => {
  const page = { path: 'wiki/entities/example.md', ...parseFrontmatter(`---\ntype: entity\ngenerated: 2026-01-02\nstatus: confirmed\nsources: []\nverified: []\nstale_after: nonsense\n---\nDO NOT LEAK THIS BODY`) , raw: `---\ntype: entity\ngenerated: 2026-01-02\nstatus: confirmed\nsources: []\nverified: []\nstale_after: nonsense\n---\nDO NOT LEAK THIS BODY` };
  const results = checkPage(page, { asOf: new Date('2026-02-01T00:00:00Z') });
  const rules = results.map((f) => f.rule);
  for (const rule of ['confirmed.unverified','stale_after.invalid','recommended.aliases','recommended.keywords','date.unquoted.generated']) assert.ok(rules.includes(rule), rule);
  assert.ok(results.every((f) => ['warn','error'].includes(f.severity)));
  assert.equal(JSON.stringify(results).includes('DO NOT LEAK'), false);
});

test('demo vault findings exactly match the checked-in expected report', async () => {
  const actual = await checkVault(resolve('demo-vault'), { asOf: new Date('2026-11-08T00:00:00Z') });
  const expected = JSON.parse(await readFile(resolve('demo-vault/EXPECTED-OKF.json'), 'utf8'));
  assert.deepEqual(actual, expected);
  assert.equal(actual.some((f) => f.rule === 'stale.expired' && f.path.endsWith('stale-page.md')), true);
  assert.equal(actual.some((f) => f.rule === 'superseded.target-missing'), true);
});

test('changed scan limits checks to explicit relative wiki pages', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ba-okf-')); t.after(() => rm(dir, { recursive: true, force: true }));
  await cp(resolve('demo-vault/wiki'), join(dir, 'wiki'), { recursive: true });
  const result = await checkVault(dir, { changed: ['wiki/queries/unquoted-date-trap.md'], asOf: new Date('2026-11-08T00:00:00Z') });
  assert.ok(result.every((f) => f.path === 'wiki/queries/unquoted-date-trap.md'));
});
