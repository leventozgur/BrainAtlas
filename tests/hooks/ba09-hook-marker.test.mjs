// SPDX-License-Identifier: MIT
// BA-09: the prompt hook marks weak (proposed or disputed) pages in the injected title line and leaves the others unchanged.
// Hermetic: temporary vault, state and HOME directories only; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHook } from '../../packages/hooks/src/index.mjs';

const NOW = new Date('2026-11-10T00:00:00Z');
const record = '  - date: "2026-01-12"\n    evidence: "review"\n    scope: "zebrafish"\n    source: "wiki/sources/z.md"\n';

async function fixture(t, pages) {
  const root = await mkdtemp(join(tmpdir(), 'ba09-hooks-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const vault = join(root, 'vault'), state = join(root, 'state'), home = join(root, 'home');
  await Promise.all([mkdir(vault), mkdir(state), mkdir(home)]);
  for (const [name, body] of Object.entries(pages)) await writeFile(join(vault, name), body);
  return {env: {HOME: home}, config: {vault: {path: vault}, stateDir: state, hooks: {mode: 'normal', deadlineMs: 4700}}};
}

async function ask(f, prompt, session) {
  const config = {...f.config, retrieval: {abstainThreshold: 0}};
  const r = await runHook({client: 'claude', event: 'prompt', stdin: JSON.stringify({session_id: session, prompt}), env: f.env, config, now: NOW});
  assert.equal(r.exitCode, 0);
  if (r.stdout === '{}') return '';
  return JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
}

const pages = {
  'weak.md': '---\nstatus: proposed\n---\n# Weak Note\n\nzebrafish weak note text.\n',
  'disputed.md': '---\nstatus: disputed\n---\n# Disputed Note\n\nzebrafish disputed note text.\n',
  'verified.md': `---\nstatus: confirmed\nverified:\n${record}---\n# Verified Note\n\nzebrafish verified note text.\n`,
  'neutral.md': '---\nstatus: draft\n---\n# Neutral Note\n\nzebrafish neutral note text.\n',
};

test('BA-09: weak pages carry an [unverified] marker before their path; verified and neutral pages are unchanged', async t => {
  const f = await fixture(t, pages);
  const context = await ask(f, 'zebrafish', 'ba09-marker');
  const lines = context.split('\n');
  assert.ok(lines.includes('Weak Note [unverified] (weak.md)'), context);
  assert.ok(lines.includes('Disputed Note [unverified] (disputed.md)'), context);
  assert.ok(lines.includes('Verified Note (verified.md)'), context);
  assert.ok(lines.includes('Neutral Note (neutral.md)'), context);
  assert.equal(context.split('[unverified]').length - 1, 2);
});

test('BA-09: a weak title line still ends with its path, so the injected-path parser keeps finding it', async t => {
  const f = await fixture(t, pages);
  const context = await ask(f, 'zebrafish', 'ba09-parse');
  for (const path of ['weak.md', 'disputed.md']) {
    assert.ok(context.split('\n').some(line => line.endsWith(`(${path})`)), path);
  }
});

test('BA-09: a small budget never cuts a weak title line inside its path', async t => {
  const f = await fixture(t, {'weak.md': '---\nstatus: proposed\n---\n# Weak Note\n\nzebrafish weak note text.\n'});
  const config = {...f.config, retrieval: {abstainThreshold: 0, budgetChars: 30}};
  const r = await runHook({client: 'claude', event: 'prompt', stdin: JSON.stringify({session_id: 'ba09-budget', prompt: 'zebrafish'}), env: f.env, config, now: NOW});
  const context = r.stdout === '{}' ? '' : JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  assert.doesNotMatch(context, /\([^()\n]*$/mu);
});
