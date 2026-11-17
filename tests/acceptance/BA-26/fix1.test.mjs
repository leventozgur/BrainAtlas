// SPDX-License-Identifier: MIT
// BA-26 blind acceptance, re-test after fix1 (commit d0dfea3): query/fragment/matrix assignments and İ/ı key folding.
// Expected values come from the fix's stated intent and the brief, not from a product run. Values are built at run
// time. Temporary vaults live under a per-run directory in the OS temp directory and are removed afterwards.
// No network.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mainRoot } from './support.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAIN = mainRoot();
const ROOT = path.resolve(HERE, '../../..');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'ba26-'));
after(() => fs.rmSync(WORK, { recursive: true, force: true }));
const safety = await import(pathToFileURL(path.join(ROOT, 'packages/core/src/safety/index.mjs')).href);
const mainSafety = await import(pathToFileURL(path.join(MAIN, 'packages/core/src/safety/index.mjs')).href);
const { runHook } = await import(pathToFileURL(path.join(ROOT, 'packages/hooks/src/index.mjs')).href);
const NOW = new Date('2026-11-11T00:00:00Z');

// Built at run time. Non-uniform, letters and digits, so no placeholder or uniform-run rule applies.
const V = 'Xq7rT2mP9kL4';
const HE = 'AbCd1234EfGh5678IjKl';
const TOKEN_SHAPE = 'AbCd1234EfGh5678IjKl';
const rules = (text) => safety.scanText(text).map((f) => f.ruleId);
const ids = (text) => new Set(rules(text));
const pad2 = (n) => String(n).padStart(2, '0');

const POSITIVES = [
  ['https://ornek.example/giris?page=2&sifre=' + V, 'secret-assignment'],
  ['https://ornek.example/giris#parola=' + V, 'secret-assignment'],
  ['https://ornek.example/api;password=' + V, 'secret-assignment'],
  ['https://ornek.example/giris?DB_ŞİFRE=' + V, 'secret-assignment'],
  ['https://ornek.example/giris?PAROLA=' + V, 'secret-assignment'],
  ['https://ornek.example/giris?ŞİFRE=' + V, 'secret-assignment'],
  ['https://ornek.example/cb?x=1&pwd=' + V, 'secret-assignment'],
  ['ornek.example/giris?sifre=' + V, 'secret-assignment'],
  ['https://ornek.example/giris?sifre=' + V + '&page=2', 'secret-assignment'],
  ['https://ornek.example/giris?sifre=' + V + '#frag', 'secret-assignment'],
  ['#/login?password=' + V, 'secret-assignment'],
  ['https://ornek.example/cb?api_key=' + HE, 'high-entropy-assignment'],
  ['https://ornek.example/cb?access_token=' + HE, 'high-entropy-assignment'],
  ['https://ornek.example/cb?token=' + TOKEN_SHAPE + '&page=2', 'high-entropy-assignment'],
  ['DB_ŞİFRE: ' + V, 'secret-assignment'],
  ['ŞİFRE: ' + V, 'secret-assignment'],
  ['Şifre: ' + V, 'secret-assignment'],
  ['PAROLA=' + V, 'secret-assignment'],
];
const NEGATIVES = [
  'https://ornek.example/ara?password_policy=strict',
  'https://ornek.example/ara?token_count=5',
  'https://ornek.example/ara?max_tokens=4096',
  'https://ornek.example/ara?sifre_politikasi=strict',
  'https://ornek.example/giris?sifre=changeme',
  'https://ornek.example/giris?password=<password>',
  'https://ornek.example/giris?token=${TOKEN}',
  'https://ornek.example/giris?password=xxxxxxxxxxxx',
  'https://ornek.example/cb?token=short1',
  'https://ornek.example/cb?id=' + HE,
  'https://ornek.example/doc#section-2',
  'https://ornek.example/s?v=0.1.0-rc.10&date=2026-11-12',
  'https://ornek.example/ara?page=2&sort=desc;jsessionid=abc',
  'https://ornek.example/cb?secret_name=vault-main',
];

test('fix1 positives: query, fragment, matrix and İ/ı-folded keys are findings with the expected rule', () => {
  const misses = POSITIVES.filter(([text, rule]) => !ids(text).has(rule)).map(([t, r]) => `${r} <- ${t.slice(0, 50)} got=[${rules(t)}]`);
  assert.deepEqual(misses, []);
});

test('fix1 negatives: safe keys, placeholders, short values, non-secret keys and fragments are not findings', () => {
  const hits = NEGATIVES.filter((t) => rules(t).length > 0).map((t) => `${t.slice(0, 60)} got=[${rules(t)}]`);
  assert.deepEqual(hits, []);
});

test('fix1 hook: query, fragment, matrix and Turkish upper-case secrets never reach prompt output', async (t) => {
  fs.mkdirSync(WORK, { recursive: true });
  const root = fs.mkdtempSync(path.join(WORK, 'fix1-hook-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const vault = path.join(root, 'vault'), home = path.join(root, 'home'), state = path.join(root, 'state');
  fs.mkdirSync(path.join(vault, 'wiki'), { recursive: true }); fs.mkdirSync(home); fs.mkdirSync(state);
  const leaks = [], shown = [];
  for (const [i, [text]] of POSITIVES.entries()) {
    // Each page carries a unique keyword so its own prompt retrieves it.
    fs.writeFileSync(path.join(vault, 'wiki', `f${i}.md`), `---\ntitle: Bağlantı ${i}\nstatus: confirmed\n---\nfix1kw${i} ${text}\n`);
  }
  for (const [i, [text]] of POSITIVES.entries()) {
    const secret = text.match(new RegExp(V.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '|' + HE))?.[0];
    const res = await runHook({ client: 'claude', event: 'prompt', stdin: JSON.stringify({ session_id: `fix1-${i}`, prompt: `fix1kw${i}` }), env: { HOME: home },
      config: { vault: { path: vault }, stateDir: state, hooks: { mode: 'normal', deadlineMs: 4700 }, retrieval: { abstainThreshold: 0 } }, now: NOW });
    const out = res.stdout.includes('additionalContext') ? JSON.parse(res.stdout).hookSpecificOutput.additionalContext : '';
    if (out.includes(`Bağlantı ${i}`)) shown.push(i);
    if (secret && out.includes(secret)) leaks.push(`${i}: ${secret.slice(0, 4)}...`);
  }
  t.diagnostic(`fix1 hook sweep: ${POSITIVES.length} prompts, pages shown ${shown.length}, raw leaks ${leaks.length}`);
  assert.ok(shown.length >= POSITIVES.length - 2, 'most pages must be retrieved, otherwise the sweep proves nothing');
  assert.deepEqual(leaks, []);
});

// Query-shaped clean material: none of these carries a secret. Each template gets 10 values.
const QCLEAN = [
  (n) => `https://ornek.example/ara?page=${n}&sort=desc`,
  (n) => `https://ornek.example/giris?password_policy=strict&n=${n}`,
  (n) => `https://ornek.example/api?token_count=${n}`,
  (n) => `https://ornek.example/api?max_tokens=${n}`,
  (n) => `https://ornek.example/giris?sifre=changeme&n=${n}`,
  (n) => `https://ornek.example/giris?password=<password>&n=${n}`,
  (n) => `https://ornek.example/cb?token=\${TOKEN}&n=${n}`,
  (n) => `https://ornek.example/doc#section-${n}`,
  (n) => `https://ornek.example/s?v=0.1.${n}&date=2026-11-${pad2(1 + (n % 28))}`,
  (n) => `https://ornek.example/ara?id=${HE}${n}`,
  (n) => `https://ornek.example/cb?secret_name=vault-${n}`,
  (n) => `https://ornek.example/ara;jsessionid=${HE}&n=${n}`,
];
const QCLEAN_ITEMS = QCLEAN.flatMap((f) => Array.from({ length: 10 }, (_, n) => f(n + 1)));

test('fix1 false positives: query-shaped clean set (120 URLs) yields no finding (rate <= 0.02)', (t) => {
  const flagged = QCLEAN_ITEMS.filter((x) => safety.scanText(x).length > 0);
  const rate = flagged.length / QCLEAN_ITEMS.length;
  t.diagnostic(`query-clean FP: ${flagged.length}/${QCLEAN_ITEMS.length} = ${rate.toFixed(4)}`);
  for (const f of flagged) t.diagnostic(`  flagged ${f.slice(0, 70)} [${rules(f)}]`);
  assert.ok(rate <= 0.02, `query-clean false-positive rate ${rate.toFixed(4)} > 0.02`);
});

test('fix1 vs main: the query pass adds no finding on query-shaped clean content that main does not report', () => {
  const extra = [];
  for (const x of QCLEAN_ITEMS) {
    const mine = safety.scanText(x).length, theirs = mainSafety.scanText(x).length;
    if (mine > theirs) extra.push(`${x.slice(0, 60)} wt=${mine} main=${theirs}`);
  }
  assert.deepEqual(extra, []);
});

test('fix1 Turkish case: ŞİFRE/PAROLA/DB_ŞİFRE mixed and lower case keys all match, values are not echoed in the finding', () => {
  for (const key of ['ŞİFRE', 'şifre', 'Şifre', 'ŞIFRE', 'PAROLA', 'parola', 'DB_ŞİFRE', 'db_parola']) {
    const text = `${key}: ${V}`;
    assert.ok(ids(text).has('secret-assignment'), `key ${key}`);
    for (const f of safety.scanText(text)) assert.ok(!Object.hasOwn(f, 'value'));
  }
});
