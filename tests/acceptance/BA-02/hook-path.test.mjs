// SPDX-License-Identifier: MIT
// BA-02 blind acceptance: runHook on a 2000-page synthetic vault returns the same envelopes with a cold and a warm cache,
// and a page added outside the process is injected by the next prompt. No network, no timing assertions.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { runHook } from '../../../packages/hooks/src/index.mjs';
import { writeSyntheticCorpus } from '../../../eval/lib/synthetic-corpus.mjs';

const NOW = new Date('2026-01-15T00:00:00Z');
// PM update (2026-11-11): the original pinned digest of main 1eeec6e's output broke as soon as BA-16 intentionally changed the
// hook's packing. Parity with 1eeec6e was verified by the blind tester before merge (hook-parity.mjs, digest b564e2448b97d7f1).
// The durable property is that the BA-02 cache never changes hook output: a cold run (no cache) and a warm run (cache hit) on
// the same vault and prompts must produce identical envelopes.
async function envelopes(vault, stateDir, queries) {
  const config = { vault: { path: path.resolve(vault) }, stateDir, hooks: { mode: 'normal', deadlineMs: 4700 }, retrieval: { abstainThreshold: 0 } };
  const digest = createHash('sha256');
  let injected = 0;
  for (let i = 0; i < queries.length; i++) {
    const out = await runHook({ client: 'claude', event: 'prompt', stdin: JSON.stringify({ prompt: queries[i] }), env: {}, config, now: NOW });
    assert.equal(out.exitCode, 0);
    digest.update(`${out.exitCode}\n${out.stdout}\n`);
    if (/\.md\)/.test(out.stdout)) injected++;
  }
  return { digest: digest.digest('hex'), injected };
}

test('hook envelopes on a 2000-page vault are identical with a cold and a warm cache', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ba02-hook-path-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const vault = path.join(home, 'vault');
  fs.mkdirSync(vault);
  const { queries } = writeSyntheticCorpus(vault, { pages: 2000, seed: 1, queryCount: 20 });
  const cold = path.join(home, 'state-cold'), warm = path.join(home, 'state-warm');
  fs.mkdirSync(cold); fs.mkdirSync(warm);
  await envelopes(vault, warm, queries.slice(0, 1)); // writes the cache for the warm run
  const a = await envelopes(vault, cold, queries);
  const b = await envelopes(vault, warm, queries);
  assert.equal(a.injected, 20, 'every prompt should inject at least one page');
  assert.equal(b.digest, a.digest);
});

test('a page added after the first prompt is injected by the next prompt', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ba02-hook-fresh-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const vault = path.join(home, 'vault'), stateDir = path.join(home, 'hook-state');
  fs.mkdirSync(path.join(vault, 'wiki'), { recursive: true }); fs.mkdirSync(stateDir);
  fs.writeFileSync(path.join(vault, 'wiki', 'base.md'), '# Base\nbaseline evidence\n');
  const config = { vault: { path: path.resolve(vault) }, stateDir, hooks: { mode: 'normal', deadlineMs: 4700 }, retrieval: { abstainThreshold: 0 } };
  const ask = async () => (await runHook({ client: 'claude', event: 'prompt', stdin: JSON.stringify({ prompt: 'what is zephyrmarker?' }), env: {}, config, now: NOW })).stdout;
  assert.ok(!(await ask()).includes('fresh.md'), 'page does not exist yet');
  fs.writeFileSync(path.join(vault, 'wiki', 'fresh.md'), '# Fresh\nzephyrmarker is the new decision\n');
  const after = await ask();
  assert.ok(after.includes('fresh.md') && after.includes('zephyrmarker'), 'new page must be injected by the next prompt');
});
