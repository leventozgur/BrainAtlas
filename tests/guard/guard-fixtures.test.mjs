// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { checkRule } from '../../scripts/guard-lib.mjs';
const fixtureRoot = resolve(new URL('./fixtures', import.meta.url).pathname);
for (const rule of ['abs-path','lite-purity','forbidden-api','license-header','lockfile']) {
  test(`${rule} guard catches bad fixture and accepts good fixture`, async () => {
    const temp = await mkdtemp(join(tmpdir(), 'ba-guard-'));
    try {
      const bad = join(temp, 'bad'); await cp(join(fixtureRoot, rule, 'bad'), bad, {recursive:true});
      const good = join(temp, 'good'); await cp(join(fixtureRoot, rule, 'good'), good, {recursive:true});
      assert.ok((await checkRule(bad, rule)).length > 0, 'bad fixture must be reported');
      assert.deepEqual(await checkRule(good, rule), []);
    } finally { await rm(temp, {recursive:true,force:true}); }
  });
}
