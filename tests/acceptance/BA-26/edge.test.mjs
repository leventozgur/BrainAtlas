// SPDX-License-Identifier: MIT
// BA-26 blind acceptance, edge cases. Expected values come from the brief and the rule definitions, not from a
// previous run. Values are built at run time; the hook and MCP are driven black-box. Temporary vaults live under
// tests/acceptance/BA-26/.work and are removed afterwards. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fixtures } from './gen.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
// Main checkout, read only: a sibling of the worktree's project folder (BA26_MAIN overrides).
const MAIN = process.env.BA26_MAIN || path.resolve(ROOT, '../../BrainAtlas');
const WORK = path.join(HERE, '.work');
const safety = await import(pathToFileURL(path.join(ROOT, 'packages/core/src/safety/index.mjs')).href);
const wtRules = await import(pathToFileURL(path.join(ROOT, 'packages/core/src/safety/rules.mjs')).href);
const mainRules = await import(pathToFileURL(path.join(MAIN, 'packages/core/src/safety/rules.mjs')).href);
const { runHook } = await import(pathToFileURL(path.join(ROOT, 'packages/hooks/src/index.mjs')).href);
const { defaultConfig } = await import(pathToFileURL(path.join(ROOT, 'packages/core/src/config/index.mjs')).href);
const NOW = new Date('2026-11-11T00:00:00Z');
const { positives, contacts } = fixtures();

// Built at run time from fragments. No literal secret value appears in this file.
const mix = (n, seed = 'aB3dE5gH7jK9mN1pQ2rS4tU6vW8xY0zA') => Array.from({ length: n }, (_, i) => seed[i % seed.length]).join('');
const pad2 = (n) => String(n).padStart(2, '0');
function tcknFrom(first9) {
  const n = [...first9].map(Number);
  const odd = n[0] + n[2] + n[4] + n[6] + n[8], even = n[1] + n[3] + n[5] + n[7];
  const d10 = ((odd * 7 - even) % 10 + 10) % 10;
  return first9 + d10 + ([...n, d10].reduce((a, b) => a + b, 0) % 10);
}
const TCKN = tcknFrom('123456789');
const BBAN = '0006100519786457841326';
const IBAN = 'TR' + pad2(98 - Number(BigInt(BBAN + '292700') % 97n)) + BBAN;
const IBAN_OK = (() => { const c = IBAN.replace(/ /g, ''); const r = c.slice(4) + c.slice(0, 4); return BigInt([...r].map((ch) => (ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch)).join('')) % 97n === 1n; })();

function makeVault(t, name) {
  fs.mkdirSync(WORK, { recursive: true });
  const root = fs.mkdtempSync(path.join(WORK, `${name}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const vault = path.join(root, 'vault'), home = path.join(root, 'home'), state = path.join(root, 'state');
  fs.mkdirSync(path.join(vault, 'wiki'), { recursive: true }); fs.mkdirSync(home); fs.mkdirSync(state);
  fs.writeFileSync(path.join(vault, 'wiki/index.md'), '# Wiki index\n');
  fs.writeFileSync(path.join(vault, 'wiki/log.md'), '# Log\n');
  return { root, vault, home, state };
}
const hookCfg = (v, budget) => ({ vault: { path: v.vault }, stateDir: v.state, hooks: { mode: 'normal', deadlineMs: 4700 }, retrieval: { abstainThreshold: 0, ...(budget ? { budgetChars: budget } : {}) } });
async function ask(v, prompt, session, budget) {
  const res = await runHook({ client: 'claude', event: 'prompt', stdin: JSON.stringify({ session_id: session, prompt }), env: { HOME: v.home }, config: hookCfg(v, budget), now: NOW });
  return res.stdout;
}
const ctxOf = (stdout) => (!stdout || stdout === '{}' ? '' : JSON.parse(stdout).hookSpecificOutput.additionalContext);
const rules = (text) => safety.scanText(text).map((f) => f.ruleId);

test('boundary: azure storage key needs 32 or more base64 characters after AccountKey=', () => {
  assert.deepEqual(rules('AccountKey=' + mix(31) + '=='), [], '31 characters is not a key');
  assert.ok(rules('AccountKey=' + mix(32) + '==').includes('azure-storage-key'), '32 characters is a key');
  assert.deepEqual(rules('AccountKey=' + 'x'.repeat(40) + '=='), [], 'placeholder run of x is not a key');
});

test('boundary: SAS signature needs 20 or more characters; sig-less query is not a finding', () => {
  const head = 'sv=2021-08-06&ss=b&se=2030-01-01T00:00:00Z&sig=';
  assert.deepEqual(rules(head + mix(19)), [], '19 characters');
  assert.ok(rules(head + mix(20)).includes('azure-sas-token'), '20 characters');
  assert.deepEqual(rules('sv=2021-08-06&ss=b&se=2030-01-01'), [], 'no sig');
});

test('boundary: bearer token needs 20 or more characters, a digit, and must not be a uniform run', () => {
  const h = 'Authorization: Bearer ';
  assert.deepEqual(rules(h + 'a1' + mix(17)), [], '19 characters');
  assert.ok(rules(h + 'a1' + mix(18)).includes('bearer-token'), '20 characters with digit');
  assert.deepEqual(rules(h + 'abcdefghijklmnopqrst'), [], 'no digit');
  assert.deepEqual(rules(h + '1'.repeat(24)), [], 'uniform run');
  assert.deepEqual(rules('authorization: bearer ' + '${TOKEN}'), [], 'placeholder');
});

test('boundary: gitlab pat is exactly 20 characters after glpat-', () => {
  assert.deepEqual(rules('glpat-' + mix(19)), [], '19');
  assert.ok(rules('glpat-' + mix(20)).includes('gitlab-pat'), '20');
  assert.deepEqual(rules('glpat-' + mix(21)), [], '21: lookahead must reject a longer token');
});

test('boundary: azure devops pat needs 52 base32 characters and a keyword context', () => {
  const b32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const pat = (n) => Array.from({ length: n }, (_, i) => b32[(i * 7) % 32]).join('');
  assert.deepEqual(rules(pat(52)), [], 'bare string without context');
  assert.ok(rules('azure_devops_pat: "' + pat(52) + '"').includes('azure-devops-pat'), 'with context');
  assert.deepEqual(rules('azure_devops_pat: "' + pat(51) + '"'), [], '51 characters');
});

test('turkish keys: placeholders and empty values are not findings, real lower-case values are', () => {
  assert.deepEqual(rules('şifre: changeme'), []);
  assert.deepEqual(rules('parola: <parola>'), []);
  assert.deepEqual(rules('sifre=""'), []);
  assert.deepEqual(rules('şifre: ${DB_SIFRE}'), []);
  assert.ok(rules('şifre: Abc12345').includes('secret-assignment'));
  assert.ok(rules('parola=Abc12345').includes('secret-assignment'));
});

test('turkish keys: upper-case Turkish keys ŞİFRE and PAROLA are assignments', () => {
  // Upper-case Turkish spelling of "şifre" is "ŞİFRE" (dotted capital İ). PAROLA has no dotted letter.
  assert.ok(rules('PAROLA: Abc12345').includes('secret-assignment'), 'PAROLA');
  assert.ok(rules('ŞİFRE: Abc12345').includes('secret-assignment'), 'ŞİFRE with dotted capital İ');
});

test('personal data: TCKN needs 11 digits, a non-zero first digit and a valid checksum; IBAN needs mod-97 validity', () => {
  assert.equal(IBAN_OK, true, 'generator self-check');
  assert.deepEqual(rules('0' + TCKN.slice(1)), [], 'leading zero');
  assert.deepEqual(rules('1' + TCKN), [], '12 digits');
  assert.deepEqual(rules(TCKN.slice(0, 10) + String((Number(TCKN[10]) + 1) % 10)), [], 'checksum neighbour');
  assert.ok(rules('X' + TCKN).includes('tckn'), 'a letter before a valid TCKN is not a digit boundary');
  assert.deepEqual(rules(IBAN.slice(0, 25) + String((Number(IBAN[25]) + 1) % 10)), [], 'iban checksum neighbour');
  assert.deepEqual(rules(IBAN.toLowerCase()), [], 'lower-case prefix');
  assert.deepEqual(rules(IBAN + '7'), [], '27 characters');
});

test('finding shape: no value field, kind personal for TCKN and IBAN, content for secrets; same identity keys', () => {
  const f = safety.scanText('TCKN: ' + TCKN + ' ' + IBAN + ' ' + 'glpat-' + mix(20));
  for (const x of f) assert.deepEqual(Object.keys(x).sort(), ['end', 'kind', 'ruleId', 'start']);
  const kinds = Object.fromEntries(f.map((x) => [x.ruleId, x.kind]));
  assert.equal(kinds.tckn, 'personal');
  assert.equal(kinds['tr-iban'], 'personal');
  assert.equal(kinds['gitlab-pat'], 'content');
});

test('allowlist: a personal finding can be allowed by its value-free fingerprint', () => {
  const text = 'TCKN: ' + TCKN;
  const f = safety.scanText(text)[0];
  const fp = safety.fingerprintSafetyFinding('wiki/a.md', text, f);
  assert.ok(safety.isSafetyFindingAllowed('wiki/a.md', text, f, [fp]));
  assert.ok(!safety.isSafetyFindingAllowed('wiki/b.md', text, f, [fp]));
  assert.ok(!JSON.stringify(fp).includes(TCKN), 'fingerprint carries no value');
});

test('rule ids: existing content-rule ids are unchanged and in the same order as main', () => {
  const mainIds = mainRules.CONTENT_RULES.map((r) => r.id);
  const wtIds = wtRules.CONTENT_RULES.map((r) => r.id);
  const kept = wtIds.filter((id) => mainIds.includes(id));
  assert.deepEqual(kept, mainIds, 'old ids in the same order');
  assert.deepEqual((mainRules.PERSONAL_RULES ?? []).map((r) => r.id), [], 'main has no personal rules');
  assert.deepEqual(wtRules.PERSONAL_RULES.map((r) => r.id), ['tckn', 'tr-iban']);
});

test('write path: wiki_write_page refuses TCKN, IBAN and secrets; accepts e-mail, phone and placeholders; no value in error', async (t) => {
  const v = makeVault(t, 'edge-mcp');
  const config = defaultConfig('lite');
  config.vault.path = v.vault;
  const configFile = path.join(v.home, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify(config));
  const transport = new StdioClientTransport({
    command: process.execPath, args: [path.join(ROOT, 'packages/mcp/bin/brainatlas-mcp.mjs')], cwd: ROOT, stderr: 'pipe',
    env: { HOME: v.home, BRAINATLAS_CONFIG: configFile, BRAINATLAS_VAULT: v.vault, PATH: process.env.PATH ?? '' },
  });
  const client = new Client({ name: 'ba26-edge', version: '1.0.0' });
  t.after(async () => { await client.close().catch(() => {}); await transport.close().catch(() => {}); });
  await client.connect(transport);
  const write = async (name, content) => {
    const r = await client.callTool({ name: 'wiki_write_page', arguments: { path: name, content } });
    return { isError: r.isError === true, text: r.content.find((c) => c.type === 'text')?.text ?? '' };
  };
  const refused = { tckn: await write('a/tckn.md', `---\ntitle: T\nstatus: proposed\n---\nKayıt: ${TCKN}\n`), iban: await write('a/iban.md', `---\ntitle: I\nstatus: proposed\n---\nÖdeme ${IBAN}\n`), sifre: await write('a/sifre.md', `---\ntitle: S\nstatus: proposed\n---\nşifre: Abc12345\n`) };
  const accepted = { email: await write('a/email.md', `---\ntitle: E\nstatus: proposed\n---\nİletişim: ali.veli@ornek.example\n`), phone: await write('a/phone.md', `---\ntitle: P\nstatus: proposed\n---\nTelefon: 0532 123 45 67\n`), placeholder: await write('a/ph.md', `---\ntitle: H\nstatus: proposed\n---\npassword: changeme\n`) };
  for (const [k, r] of Object.entries(refused)) {
    assert.ok(r.isError, `${k} must be refused`);
    assert.ok(r.text.includes('E_SECRET_DETECTED'), `${k} refusal code`);
    assert.ok(!r.text.includes(TCKN) && !r.text.includes(IBAN) && !r.text.includes('Abc12345'), `${k} error must not echo the value`);
  }
  for (const [k, r] of Object.entries(accepted)) assert.ok(!r.isError, `${k} must be accepted: ${r.text.slice(0, 120)}`);
});

test('hook: TCKN, IBAN, e-mail, phone and GitLab token in a page are redacted in output; no raw value', async (t) => {
  const v = makeVault(t, 'edge-hook');
  const token = 'glpat-' + mix(20);
  fs.writeFileSync(path.join(v.vault, 'wiki/contacts.md'), `---\ntitle: Müşteri kaydı\nstatus: confirmed\n---\nkimlik-kaydı zz9 TCKN ${TCKN} IBAN ${IBAN} mail ali.veli@ornek.example tel 0532 123 45 67 token ${token}\n`);
  const out = ctxOf(await ask(v, 'kimlik-kaydı zz9 müşteri', 'edge-hook-s'));
  assert.ok(out.includes('Müşteri kaydı'), 'page must be retrieved (non-vacuous)');
  for (const raw of [TCKN, IBAN, 'ali.veli@ornek.example', '0532 123 45 67', token]) assert.ok(!out.includes(raw), `raw value leaked: ${raw.slice(0, 6)}...`);
  for (const marker of ['[REDACTED:tckn]', '[REDACTED:tr-iban]', '[REDACTED:email]', '[REDACTED:tr-phone]', '[REDACTED:gitlab-pat]']) assert.ok(out.includes(marker), `missing ${marker}`);
});

test('hook: every scanText and contact positive leaves no raw value in prompt output (non-vacuous)', async (t) => {
  const v = makeVault(t, 'edge-all');
  const items = [...positives, ...contacts];
  const raw = new Map();
  items.forEach((it, i) => {
    fs.writeFileSync(path.join(v.vault, 'wiki', `r${i}.md`), `---\ntitle: Kayıt ${i}\nstatus: confirmed\n---\nkwq${i} ${it.text}\n`);
    // The raw value is the generator's own value (not what the product found), so a missed value is still checked.
    raw.set(i, [it.value]);
  });
  const leaks = [], shown = [];
  for (let i = 0; i < items.length; i++) {
    const out = ctxOf(await ask(v, `kwq${i}`, `edge-all-${i}`));
    if (out.includes(`Kayıt ${i}`)) shown.push(i);
    for (const val of raw.get(i)) if (out.includes(val)) leaks.push(`${items[i].id}: ${val.slice(0, 4)}...`);
  }
  t.diagnostic(`all-positives hook sweep: ${items.length} prompts, pages shown ${shown.length}, raw leaks ${leaks.length}`);
  assert.ok(shown.length >= Math.floor(items.length * 0.5), 'most pages must be retrieved, otherwise the sweep proves nothing');
  assert.deepEqual(leaks, []);
});

test('hook: partial digits of a TCKN or IBAN never appear at an excerpt boundary (budget sweep)', async (t) => {
  const v = makeVault(t, 'edge-cut');
  const leaks = [];
  let runs = 0, shownRuns = 0;
  for (const budget of [200, 260, 330, 420, 600, 1000]) {
    for (let k = 0; k <= 120; k += 6) {
      fs.writeFileSync(path.join(v.vault, 'wiki/cut.md'), `---\ntitle: Kesim sınaması\nstatus: confirmed\n---\nkwcut ${'x '.repeat(k)}${TCKN} ${IBAN}\n`);
      const out = ctxOf(await ask(v, 'kwcut', `cut-${budget}-${k}`, budget));
      runs++;
      if (out) shownRuns++;
      // Any run of 6 or more consecutive digits of the TCKN, or of the IBAN digits, is a partial value.
      for (let s = 0; s + 6 <= TCKN.length; s++) if (out.includes(TCKN.slice(s, s + 6))) { leaks.push(`budget ${budget} k ${k}: TCKN fragment ${s}`); break; }
      const ibanDigits = IBAN.replace(/ /g, '');
      for (let s = 0; s + 8 <= ibanDigits.length; s++) if (out.includes(ibanDigits.slice(s, s + 8))) { leaks.push(`budget ${budget} k ${k}: IBAN fragment ${s}`); break; }
    }
  }
  t.diagnostic(`cut sweep: ${runs} runs, runs with context ${shownRuns}, partial leaks ${leaks.length}`);
  assert.ok(shownRuns > 0, 'the page must be injected in some runs, otherwise the sweep proves nothing');
  assert.deepEqual(leaks, []);
});

test('hook: restricted pages with case or quoting variants (Personal, NEVER, quoted) are never injected', async (t) => {
  const v = makeVault(t, 'edge-restricted');
  const variants = [
    ['wiki/v1.md', 'sensitivity: Personal', 'Birinci varyant kelimesi tilkazebra'],
    ['wiki/v2.md', 'inject: NEVER', 'İkinci varyant kelimesi tilkazebra'],
    ['wiki/v3.md', 'sensitivity: "PERSONAL"', 'Üçüncü varyant kelimesi tilkazebra'],
    ['wiki/v4.md', 'inject: "never"', 'Dördüncü varyant kelimesi tilkazebra'],
  ];
  for (const [p, fm, body] of variants) fs.writeFileSync(path.join(v.vault, p), `---\ntitle: ${body.slice(0, 12)}\nstatus: confirmed\n${fm}\n---\n${body}\n`);
  fs.writeFileSync(path.join(v.vault, 'wiki/open.md'), '---\ntitle: Açık tilkazebra\nstatus: confirmed\n---\nAçık tilkazebra notu.\n');
  const out = await ask(v, 'tilkazebra varyant', 'edge-restricted-s');
  for (const [, , body] of variants) assert.ok(!out.includes(body.slice(0, 20)), `restricted variant leaked: ${body.slice(0, 12)}`);
  assert.ok(out.includes('Açık tilkazebra'), 'open control page must be injected');
});

test('hook: session-start recap never names a restricted page', async (t) => {
  const v = makeVault(t, 'edge-recap');
  fs.writeFileSync(path.join(v.vault, 'wiki/recap-secret.md'), '---\ntitle: Gizli özet kaydı\nstatus: confirmed\nsensitivity: personal\n---\nGizli özet kaydı içeriği.\n');
  fs.writeFileSync(path.join(v.vault, 'wiki/recap-open.md'), '---\ntitle: Açık özet kaydı\nstatus: confirmed\n---\nAçık özet kaydı içeriği.\n');
  // The recap is built from dated log lines (14-day window), so both pages are logged as recently changed.
  fs.writeFileSync(path.join(v.vault, 'wiki/log.md'), '# Log\n- 2026-11-10T10:00:00Z {"action":"write","path":"wiki/recap-secret.md"}\n- 2026-11-10T10:01:00Z {"action":"write","path":"wiki/recap-open.md"}\n');
  const res = await runHook({ client: 'claude', event: 'session-start', stdin: JSON.stringify({ session_id: 'edge-recap-s', source: 'startup' }), env: { HOME: v.home }, config: hookCfg(v), now: NOW });
  const out = ctxOf(res.stdout);
  t.diagnostic(`session-start output length ${out.length}, mentions open page: ${out.includes('Açık özet kaydı')}`);
  assert.ok(out.includes('Açık özet kaydı'), 'open page must appear in the recap (otherwise the test is vacuous)');
  assert.ok(!out.includes('Gizli özet kaydı'), 'restricted title in recap');
  assert.ok(!out.includes('recap-secret'), 'restricted path in recap');
});

test('known gap check: assignment inside a URL with a scheme (https://...?sifre=...) is a finding', () => {
  // Pre-existing behaviour: a URL with a scheme consumes the following text as the value of the scheme key, so a
  // query-string assignment is not seen. The bare query form is detected by the new Turkish rule.
  const url = 'https://ornek.example/giris?sifre=' + mix(12, 'Xq7rT2mP9kL4zB8');
  assert.ok(rules(url).includes('secret-assignment'), 'https URL query sifre= assignment');
});
