// SPDX-License-Identifier: MIT
// BA-26 blind acceptance, hypothesis 3: restricted pages (sensitivity personal, inject never) never reach hook output,
// are never marked as shown, and stay findable by wiki_query (stdio MCP) and by the core search.
// Hermetic: temporary vaults live under a per-run directory in the OS temp directory and are removed afterwards.
// No network.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'ba26-'));
after(() => fs.rmSync(WORK, { recursive: true, force: true }));
const { runHook } = await import(pathToFileURL(path.join(ROOT, 'packages/hooks/src/index.mjs')).href);
const { createSearcher } = await import(pathToFileURL(path.join(ROOT, 'packages/core/src/retrieval/index.mjs')).href);
const { defaultConfig } = await import(pathToFileURL(path.join(ROOT, 'packages/core/src/config/index.mjs')).href);
const NOW = new Date('2026-11-11T00:00:00Z');

// Restricted pages. Keywords are unique to them, so a prompt that uses them makes the restricted page the best match.
const RESTRICTED = [
  { path: 'wiki/personal-budget.md', title: 'Kişisel bütçe defteri', kw: 'quorumzebra',
    fm: 'sensitivity: personal', body: 'Kişisel bütçe defteri: quorumzebra harcama kalemleri ve aylık maaş notları.' },
  { path: 'wiki/hidden-work-note.md', title: 'Gizli çalışma notu', kw: 'velvetmarmot',
    fm: 'inject: never', body: 'Gizli çalışma notu: velvetmarmot tedarikçi görüşmesi ve fiyat pazarlığı.' },
  { path: 'wiki/quoted-restricted.md', title: 'Sağlık kaydı', kw: 'harbourlynx',
    fm: 'sensitivity: "personal"', crlf: true, body: 'Sağlık kaydı: harbourlynx tahlil sonuçları.' },
  { path: 'wiki/inject-quoted.md', title: 'Tek tırnaklı kayıt', kw: 'pelicanorbit',
    fm: "inject: 'never'", body: 'Tek tırnaklı kayıt: pelicanorbit karar notu.' },
  { path: 'wiki/long-frontmatter.md', title: 'Uzun ön madde kaydı', kw: 'ostrichdelta',
    fm: 'notes: "' + 'uzun-not-'.repeat(700) + '"\nsensitivity: personal', body: 'Uzun ön madde kaydı: ostrichdelta notları.' },
];
const CONTROL = { path: 'wiki/control-open.md', title: 'Açık kontrol notu', body: 'Açık kontrol notu: ortak kavramlar ve sürüm bilgileri.' };
const PROMPTS = [
  'quorumzebra harcama kalemleri nedir?',
  'quorumzebra maaş notları',
  'kişisel bütçe defteri quorumzebra',
  'velvetmarmot tedarikçi görüşmesi nasıl?',
  'velvetmarmot fiyat pazarlığı',
  'gizli çalışma notu velvetmarmot',
  'harbourlynx tahlil sonuçları',
  'sağlık kaydı harbourlynx',
  'ostrichdelta notes',
  'ostrichdelta ne anlama gelir',
  'pelicanorbit karar',
  'pelicanorbit inject never',
];

function fileText(p) {
  const fm = `---\ntitle: ${p.title}\nstatus: confirmed\n${p.fm}\n---\n`;
  const text = fm + p.body + '\n';
  return p.crlf ? text.replace(/\n/g, '\r\n') : text;
}
function makeVault(t, name) {
  fs.mkdirSync(WORK, { recursive: true });
  const root = fs.mkdtempSync(path.join(WORK, `${name}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'), vault = path.join(root, 'vault'), state = path.join(root, 'state');
  fs.mkdirSync(path.join(vault, 'wiki'), { recursive: true });
  fs.mkdirSync(home); fs.mkdirSync(state);
  for (const p of [...RESTRICTED, CONTROL]) fs.writeFileSync(path.join(vault, p.path), fileText({ fm: 'kind: open', ...p }));
  fs.writeFileSync(path.join(vault, 'wiki/index.md'), '# Wiki index\n');
  fs.writeFileSync(path.join(vault, 'wiki/log.md'), '# Log\n');
  return { root, home, vault, state };
}
async function ask(v, prompt, session) {
  const config = { vault: { path: v.vault }, stateDir: v.state, hooks: { mode: 'normal', deadlineMs: 4700 }, retrieval: { abstainThreshold: 0 } };
  const res = await runHook({ client: 'claude', event: 'prompt', stdin: JSON.stringify({ session_id: session, prompt }), env: { HOME: v.home }, config, now: NOW });
  return res.stdout;
}
function leakedMarkers(out) {
  const markers = [];
  for (const p of RESTRICTED) {
    if (out.includes(p.path)) markers.push(`path:${p.path}`);
    if (out.includes(p.title)) markers.push(`title:${p.title}`);
    if (out.includes(p.kw)) markers.push(`kw:${p.kw}`);
  }
  return markers;
}

test('H3 hook: restricted pages never appear in prompt-hook output (12 prompts, best match forced)', async (t) => {
  const v = makeVault(t, 'h3');
  const searcher = createSearcher({ vaultDir: v.vault, stateDir: v.state, now: NOW });
  const leaks = [];
  for (const [i, prompt] of PROMPTS.entries()) {
    const top = searcher.search(prompt, { limit: 5, abstainThreshold: 0 }).results[0];
    const topIsRestricted = top && RESTRICTED.some((p) => p.path === top.path);
    if (!topIsRestricted) t.diagnostic(`precondition: top hit for prompt ${i} is not restricted: ${top?.path ?? 'none'}`);
    const out = await ask(v, prompt, 'h3-session');
    const m = leakedMarkers(out);
    if (m.length) leaks.push(`prompt ${i}: ${m.join(', ')}`);
  }
  // Sanity: the same hook does inject an unrestricted page, so the absence above is not a dead hook.
  const control = await ask(v, 'açık kontrol notu ortak kavramlar', 'h3-control');
  t.diagnostic(`H3 prompts: ${PROMPTS.length}, leaks: ${leaks.length}, control injected: ${control.includes(CONTROL.title)}`);
  assert.ok(control.includes(CONTROL.title), 'control page must be injected (otherwise the test is inconclusive)');
  assert.deepEqual(leaks, [], 'restricted content in hook output');
});

test('H3 state: restricted pages are never marked as shown in the hook state', async (t) => {
  const v = makeVault(t, 'h3s');
  for (const [, prompt] of PROMPTS.entries()) await ask(v, prompt, 'h3-state-session');
  await ask(v, 'açık kontrol notu ortak kavramlar', 'h3-state-session');
  const hooksDir = path.join(v.state, 'hooks');
  const files = fs.existsSync(hooksDir) ? fs.readdirSync(hooksDir) : [];
  const text = files.map((f) => fs.readFileSync(path.join(hooksDir, f), 'utf8')).join('\n');
  t.diagnostic(`H3 state files: ${files.length}`);
  for (const p of RESTRICTED) assert.ok(!text.includes(p.path), `restricted path marked as shown: ${p.path}`);
  assert.ok(text.includes(CONTROL.path), 'control page must be recorded as shown (state tracking works)');
});

test('H3 wiki_query (stdio MCP) and core search still find every restricted page', async (t) => {
  const v = makeVault(t, 'h3m');
  const config = defaultConfig('lite');
  config.vault.path = v.vault;
  const configFile = path.join(v.home, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify(config));
  const transport = new StdioClientTransport({
    command: process.execPath, args: [path.join(ROOT, 'packages/mcp/bin/brainatlas-mcp.mjs')], cwd: ROOT, stderr: 'pipe',
    env: { HOME: v.home, BRAINATLAS_CONFIG: configFile, BRAINATLAS_VAULT: v.vault, PATH: process.env.PATH ?? '' },
  });
  const client = new Client({ name: 'ba26-acceptance', version: '1.0.0' });
  t.after(async () => { await client.close().catch(() => {}); await transport.close().catch(() => {}); });
  await client.connect(transport);
  const missing = [];
  const searcher = createSearcher({ vaultDir: v.vault, stateDir: v.state, now: NOW });
  for (const p of RESTRICTED) {
    const result = await client.callTool({ name: 'wiki_query', arguments: { query: p.kw + ' ' + p.title, limit: 5 } });
    const text = result.content.find((c) => c.type === 'text')?.text ?? '';
    // wiki_query returns wiki-relative paths (no leading wiki/) and marks restricted hits with inject:never.
    const rel = p.path.replace(/^wiki\//, '');
    if (result.isError || !text.includes(`"path":"${rel}"`)) missing.push(`wiki_query:${p.path}`);
    const core = searcher.search(p.kw + ' ' + p.title, { limit: 5, abstainThreshold: 0 }).results.map((r) => r.path);
    if (!core.includes(p.path)) missing.push(`core:${p.path}`);
  }
  assert.deepEqual(missing, [], 'restricted pages must stay searchable');
});
