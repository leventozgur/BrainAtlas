// SPDX-License-Identifier: MIT
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mainRoot } from './support.mjs';
import { fixtures } from './gen.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAIN = mainRoot();
const WT = path.resolve(HERE, '../../..');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'ba26-'));
after(() => fs.rmSync(WORK, { recursive: true, force: true }));
const load = async (root) => ({
  safety: await import(pathToFileURL(path.join(root, 'packages/core/src/safety/index.mjs')).href),
  retrieval: await import(pathToFileURL(path.join(root, 'packages/core/src/retrieval/index.mjs')).href),
  hooks: await import(pathToFileURL(path.join(root, 'packages/hooks/src/index.mjs')).href),
});
const W = await load(WT);
const M = await load(MAIN);
const NOW = new Date('2026-11-11T00:00:00Z');
const { cleanItems } = fixtures();

const PROSE = [
  'Bu sayfa hook çıktısının ana repo ile aynı olduğunu doğrular.',
  'Deploy sonrası health check 200 döndü ve log dosyası temiz.',
  'Anthropic anahtarı örneği: sk-ant-' + 'a'.repeat(24) + ' (eski kural, değişmemeli)',
  'Kullanıcı adı ile repo adı aynı olmalı; parola alanı burada yok.',
  'Hata mesajı: E_PATH_ESCAPE dönüyor, yol dışarı çıkıyor.',
];

test('H4 scanText: identical findings on clean and prose content', () => {
  const diffs = [];
  for (const it of [...cleanItems.map((c) => c.text), ...PROSE]) {
    const a = JSON.stringify(W.safety.scanText(it)),
      b = JSON.stringify(M.safety.scanText(it));
    if (a !== b) diffs.push(it.slice(0, 60));
  }
  assert.deepEqual(diffs, []);
});

test('H4 redact: identical output with and without the personal option on clean content', () => {
  const diffs = [];
  for (const it of [...cleanItems.map((c) => c.text), ...PROSE]) {
    for (const opts of [{}, { personal: true }]) {
      if (W.safety.redact(it, opts) !== M.safety.redact(it, opts))
        diffs.push(`${JSON.stringify(opts)} ${it.slice(0, 40)}`);
    }
  }
  assert.deepEqual(diffs, []);
});

function makeVault(t, name, pages) {
  fs.mkdirSync(WORK, { recursive: true });
  const root = fs.mkdtempSync(path.join(WORK, `${name}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const vault = path.join(root, 'vault'),
    home = path.join(root, 'home'),
    state = path.join(root, 'state');
  fs.mkdirSync(path.join(vault, 'wiki'), { recursive: true });
  fs.mkdirSync(home);
  fs.mkdirSync(state);
  for (const [p, body] of Object.entries(pages)) fs.writeFileSync(path.join(vault, 'wiki', p), body);
  return { root, vault, home, state };
}
const PAGES = {
  'deploy-check.md':
    '---\ntitle: Deploy health check\nstatus: confirmed\n---\n# Deploy health check\nHealth check returns 200 after deploy; the log stays clean.\n',
  'retrieval-notes.md':
    '---\ntitle: Retrieval notes\nstatus: proposed\n---\nRetrieval uses a lexical index with a stem filter and abstain threshold.\n',
  'release-log.md':
    '---\ntitle: Release log\nstatus: confirmed\n---\n# Release log\nVersion 0.1.0-rc.10 shipped with hook budget notes and error codes E_PATH_ESCAPE.\n',
  'ops-glossary.md':
    '---\ntitle: Ops glossary\nstatus: neutral\n---\nRunbook terms: canary, rollback, budget, deadline and worker.\n',
};
const QUERIES = [
  'deploy health check',
  'retrieval abstain threshold',
  'release 0.1.0-rc.10',
  'ops glossary rollback',
  'E_PATH_ESCAPE',
];
const PROMPTS = [
  'How do I run the deploy health check?',
  'retrieval abstain threshold nedir?',
  'release notes for 0.1.0-rc.10',
  'ops glossary rollback budget',
];

test('H4 search: identical ranked results on a vault without sensitive fields', (t) => {
  const v = makeVault(t, 'h4s', PAGES);
  const pagesW = W.retrieval.loadPages(v.vault),
    pagesM = M.retrieval.loadPages(v.vault);
  const idxW = W.retrieval.buildIndex(pagesW, { now: NOW }),
    idxM = M.retrieval.buildIndex(pagesM, { now: NOW });
  const diffs = [];
  let nonEmpty = 0;
  for (const q of QUERIES) {
    if (W.retrieval.search(idxW, q, { limit: 5, budgetChars: 4000, abstainThreshold: 0 }).results.length) nonEmpty++;
    const a = JSON.stringify(W.retrieval.search(idxW, q, { limit: 5, budgetChars: 4000, abstainThreshold: 0 }));
    const b = JSON.stringify(M.retrieval.search(idxM, q, { limit: 5, budgetChars: 4000, abstainThreshold: 0 }));
    if (a !== b) diffs.push(q);
  }
  assert.ok(nonEmpty >= 3, 'queries must return results, otherwise parity is vacuous');
  assert.deepEqual(diffs, []);
});

test('H4 hook: identical prompt-hook output on a vault without sensitive fields', async (t) => {
  const vw = makeVault(t, 'h4hw', PAGES),
    vm = makeVault(t, 'h4hm', PAGES);
  const run = (mod, v, prompt, session) =>
    mod.hooks.runHook({
      client: 'claude',
      event: 'prompt',
      stdin: JSON.stringify({ session_id: session, prompt }),
      env: { HOME: v.home },
      config: {
        vault: { path: v.vault },
        stateDir: v.state,
        hooks: { mode: 'normal', deadlineMs: 4700 },
        retrieval: { abstainThreshold: 0 },
      },
      now: NOW,
    });
  const diffs = [];
  let injected = 0;
  for (const [i, prompt] of PROMPTS.entries()) {
    const a = await run(W, vw, prompt, `s${i}`),
      b = await run(M, vm, prompt, `s${i}`);
    if (a.stdout.includes('additionalContext')) injected++;
    if (a.stdout !== b.stdout || a.exitCode !== b.exitCode) diffs.push(prompt);
  }
  t.diagnostic(`H4 hook prompts compared: ${PROMPTS.length}, with injected context: ${injected}`);
  assert.ok(injected >= 2, 'hook must inject context for parity to be meaningful');
  assert.deepEqual(diffs, []);
});
