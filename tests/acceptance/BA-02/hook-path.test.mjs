// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runHook } from '../../../packages/hooks/src/index.mjs';
import { writeSyntheticCorpus } from '../../../eval/lib/synthetic-corpus.mjs';

const NOW = new Date('2026-01-15T00:00:00Z');
async function envelopes(vault, stateDir, queries) {
  const config = {
    vault: { path: path.resolve(vault) },
    stateDir,
    hooks: { mode: 'normal', deadlineMs: 4700 },
    retrieval: { abstainThreshold: 0 },
  };
  const digest = createHash('sha256');
  let injected = 0;
  for (let i = 0; i < queries.length; i++) {
    const out = await runHook({
      client: 'claude',
      event: 'prompt',
      stdin: JSON.stringify({ prompt: queries[i] }),
      env: {},
      config,
      now: NOW,
    });
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
  const cold = path.join(home, 'state-cold'),
    warm = path.join(home, 'state-warm');
  fs.mkdirSync(cold);
  fs.mkdirSync(warm);
  await envelopes(vault, warm, queries.slice(0, 1));
  const a = await envelopes(vault, cold, queries);
  const b = await envelopes(vault, warm, queries);
  assert.equal(a.injected, 20, 'every prompt should inject at least one page');
  assert.equal(b.digest, a.digest);
});

test('a page added after the first prompt is injected by the next prompt', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ba02-hook-fresh-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const vault = path.join(home, 'vault'),
    stateDir = path.join(home, 'hook-state');
  fs.mkdirSync(path.join(vault, 'wiki'), { recursive: true });
  fs.mkdirSync(stateDir);
  fs.writeFileSync(path.join(vault, 'wiki', 'base.md'), '# Base\nbaseline evidence\n');
  const config = {
    vault: { path: path.resolve(vault) },
    stateDir,
    hooks: { mode: 'normal', deadlineMs: 4700 },
    retrieval: { abstainThreshold: 0 },
  };
  const ask = async () =>
    (
      await runHook({
        client: 'claude',
        event: 'prompt',
        stdin: JSON.stringify({ prompt: 'what is zephyrmarker?' }),
        env: {},
        config,
        now: NOW,
      })
    ).stdout;
  assert.ok(!(await ask()).includes('fresh.md'), 'page does not exist yet');
  fs.writeFileSync(path.join(vault, 'wiki', 'fresh.md'), '# Fresh\nzephyrmarker is the new decision\n');
  const after = await ask();
  assert.ok(
    after.includes('fresh.md') && after.includes('zephyrmarker'),
    'new page must be injected by the next prompt'
  );
});
