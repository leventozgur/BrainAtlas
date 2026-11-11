// SPDX-License-Identifier: MIT
// BA-09 blind acceptance: the prompt hook marks only weak pages (`[unverified]` before the path). Verified and neutral pages keep
// the previous title line. Contract: docs/contracts/retrieval.md, "Result field"; docs/user/okf.md, "Effect on retrieval".
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runHook } from '../../../packages/hooks/src/index.mjs';
import { makeVault, removeDir, page, record, NOW, repoRoot } from './helpers.mjs';

const dirs = [];
after(() => dirs.forEach(removeDir));

const VERIFIED = `status: confirmed\n${record({})}`;
const QUERY = 'lumen rollout window';

async function promptContext(files) {
  const vault = makeVault(files, 'ba09-hook-vault-');
  const home = makeVault({}, 'ba09-hook-home-');
  const state = path.join(home, 'state');
  dirs.push(vault, home);
  const config = { vault: { path: vault }, stateDir: state, hooks: { mode: 'normal', deadlineMs: 4700 }, retrieval: { abstainThreshold: 0 } };
  const out = await runHook({ client: 'claude', event: 'prompt', stdin: JSON.stringify({ prompt: QUERY, session_id: 'ba09-session' }), env: { HOME: home }, config, now: NOW });
  assert.equal(out.exitCode, 0);
  return JSON.parse(out.stdout).hookSpecificOutput.additionalContext;
}

test('only a weak page gets the [unverified] marker; the line still ends with its path', async () => {
  const context = await promptContext({
    'draft.md': page({ title: 'Lumen Draft', fm: 'status: proposed\n', body: 'lumen rollout window draft proposal.' }),
    'record.md': page({ title: 'Lumen Record', fm: VERIFIED, body: 'lumen rollout window confirmed record.' }),
    'notes.md': page({ title: 'Lumen Notes', body: 'lumen rollout window informal notes.' }),
  });
  assert.ok(context.includes('Lumen Draft [unverified] (draft.md)'), context);
  assert.ok(context.includes('Lumen Record (record.md)'), context);
  assert.ok(context.includes('Lumen Notes (notes.md)'), context);
  assert.equal(context.match(/\[unverified\]/g).length, 1, 'exactly one marker');
  assert.ok(!context.includes('Lumen Record [unverified]'));
  assert.ok(!context.includes('Lumen Notes [unverified]'));
});

test('disputed pages get the marker as well, and a page without records and not weak gets none', async () => {
  const context = await promptContext({
    'dispute.md': page({ title: 'Lumen Dispute', fm: 'status: disputed\n', body: 'lumen rollout window disputed claim.' }),
    'plain.md': page({ title: 'Lumen Plain', fm: 'status: Proposed\n', body: 'lumen rollout window plain notes.' }),
  });
  assert.ok(context.includes('Lumen Dispute [unverified] (dispute.md)'), context);
  assert.ok(context.includes('Lumen Plain (plain.md)'), context);
  assert.ok(!context.includes('Lumen Plain [unverified]'));
});

test('a corpus without provenance produces no marker at all', async () => {
  const context = await promptContext({
    'a.md': page({ title: 'Lumen A', body: 'lumen rollout window notes a.' }),
    'b.md': page({ title: 'Lumen B', body: 'lumen rollout window notes b.' }),
  });
  assert.ok(context.length > 0, 'the hook returns the matched pages');
  assert.ok(!context.includes('[unverified]'));
});
