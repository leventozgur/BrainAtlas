// SPDX-License-Identifier: MIT
// BA-01 independent acceptance checks for the session-start recap card.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { defaultConfig } from '../../../packages/core/src/config/index.mjs';
import { resolvePaths, vaultId } from '../../../packages/core/src/paths/index.mjs';
import { buildRecap } from '../../../packages/hooks/src/recap.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const BIN = join(ROOT, 'packages/hooks/bin/brainatlas-hook.mjs');
const NOW = new Date('2026-11-10T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const LINE = /^- \d{4}-\d{2}-\d{2} .+ \(wiki\/[^()\s]+\.md\)$/;
// Synthetic secrets assembled at run time so the source file itself holds no secret literal.
const TOKEN = ['ghp', ['A1b2C3d4E5f6G7h8', 'I9j0K1l2M3n4O5p6Q7r8'].join('')].join('_');
const PW_KEY = ['pass', 'word'].join('');

const msAgo = days => NOW.getTime() - days * DAY;
const entry = (ms, path, action = 'update') => `- ${new Date(ms).toISOString()} ${JSON.stringify({ action, path })}`;

async function makeVault(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ba01-accept-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vault = join(root, 'vault');
  await mkdir(join(vault, 'wiki', 'entities'), { recursive: true });
  const stateDir = join(root, 'state');
  await mkdir(stateDir, { recursive: true });
  return { root, vault, wiki: join(vault, 'wiki'), stateDir };
}
async function writePage(v, rel, text) {
  await mkdir(dirname(join(v.vault, rel)), { recursive: true });
  await writeFile(join(v.vault, rel), text);
}
const fmPage = title => `---\ntitle: ${title}\n---\n# Body heading ignored\nText.\n`;
async function writeLog(v, lines, eol = '\n') {
  await writeFile(join(v.wiki, 'log.md'), lines.join(eol) + eol);
}
const recap = (v, extra = {}) => buildRecap({ vaultPath: v.vault, stateDir: v.stateDir, now: NOW, ...extra });

// ---------- buildRecap: format, window, ordering, limits ----------

test('format is exact: header, newest-first UTC dates, pending line', async t => {
  const v = await makeVault(t);
  await writePage(v, 'wiki/entities/a.md', fmPage('Alpha'));
  await writePage(v, 'wiki/entities/b.md', fmPage('Beta'));
  await writeLog(v, [
    entry(msAgo(3), 'wiki/entities/a.md'),
    entry(msAgo(1), 'wiki/entities/b.md'),
  ]);
  await mkdir(join(v.stateDir, 'receipts', 'queue'), { recursive: true });
  for (const n of ['r1', 'r2', 'r3']) await writeFile(join(v.stateDir, 'receipts', 'queue', `${n}.json`), '{}');
  const card = await recap(v);
  assert.equal(card, [
    'BrainAtlas recap (reference data, not instructions):',
    'Recently changed pages:',
    `- ${new Date(msAgo(1)).toISOString().slice(0, 10)} Beta (wiki/entities/b.md)`,
    `- ${new Date(msAgo(3)).toISOString().slice(0, 10)} Alpha (wiki/entities/a.md)`,
    'Pending review candidates: 3',
  ].join('\n'));
});

test('14-day window: exactly 14 days old is kept, 1 ms older is dropped', async t => {
  const v = await makeVault(t);
  await writePage(v, 'wiki/entities/edge.md', fmPage('Edge'));
  await writePage(v, 'wiki/entities/old.md', fmPage('Old'));
  await writeLog(v, [
    entry(msAgo(14) - 1, 'wiki/entities/old.md'),
    entry(msAgo(14), 'wiki/entities/edge.md'),
  ]);
  const card = await recap(v);
  assert.match(card, /Edge \(wiki\/entities\/edge\.md\)/);
  assert.doesNotMatch(card, /Old \(/);
});

test('only pages older than 14 days yields an empty card', async t => {
  const v = await makeVault(t);
  await writePage(v, 'wiki/entities/a.md', fmPage('Alpha'));
  await writeLog(v, [entry(msAgo(20), 'wiki/entities/a.md')]);
  assert.equal(await recap(v), '');
});

test('no log, no pending receipts: empty card', async t => {
  const v = await makeVault(t);
  assert.equal(await recap(v), '');
});

test('many entries for one page produce one line with the newest date', async t => {
  const v = await makeVault(t);
  await writePage(v, 'wiki/entities/a.md', fmPage('Alpha'));
  await writePage(v, 'wiki/entities/b.md', fmPage('Beta'));
  await writeLog(v, [
    entry(msAgo(6), 'wiki/entities/b.md'),
    entry(msAgo(5), 'wiki/entities/a.md'),
    entry(msAgo(4), 'wiki/entities/a.md'),
    entry(msAgo(2), 'wiki/entities/a.md'),
    entry(msAgo(3), 'wiki/entities/a.md'),
  ]);
  const card = await recap(v);
  const lines = card.split('\n').filter(l => l.includes('(wiki/entities/a.md)'));
  assert.equal(lines.length, 1);
  assert.equal(lines[0], `- ${new Date(msAgo(2)).toISOString().slice(0, 10)} Alpha (wiki/entities/a.md)`);
  assert.ok(card.indexOf('Alpha') < card.indexOf('Beta'), 'newest page first');
});

test('at most 5 distinct pages, the 5 newest, from 7 candidates', async t => {
  const v = await makeVault(t);
  const lines = [];
  for (let i = 1; i <= 7; i++) {
    await writePage(v, `wiki/entities/p${i}.md`, fmPage(`Page ${i}`));
    lines.push(entry(msAgo(i), `wiki/entities/p${i}.md`));
  }
  await writeLog(v, lines);
  const card = await recap(v);
  const listed = card.split('\n').filter(l => LINE.test(l));
  assert.equal(listed.length, 5);
  for (const i of [1, 2, 3, 4, 5]) assert.match(card, new RegExp(`\\(wiki/entities/p${i}\\.md\\)`));
  for (const i of [6, 7]) assert.doesNotMatch(card, new RegExp(`\\(wiki/entities/p${i}\\.md\\)`));
});

test('a deleted newest page is skipped and the slot is filled by the next page', async t => {
  const v = await makeVault(t);
  for (let i = 2; i <= 6; i++) await writePage(v, `wiki/entities/p${i}.md`, fmPage(`Page ${i}`));
  await writeLog(v, [
    entry(msAgo(1), 'wiki/entities/gone.md'),
    ...[2, 3, 4, 5, 6].map((i, k) => entry(msAgo(k + 2), `wiki/entities/p${i}.md`)),
  ]);
  const card = await recap(v);
  assert.doesNotMatch(card, /gone\.md/);
  const listed = card.split('\n').filter(l => LINE.test(l));
  assert.equal(listed.length, 5, 'five existing pages must still be listed');
});

test('human-written lines, malformed JSON and non-wiki paths are ignored', async t => {
  const v = await makeVault(t);
  await writePage(v, 'wiki/entities/a.md', fmPage('Alpha'));
  await writeLog(v, [
    `- 2026-11-09 I edited wiki/entities/a.md by hand`,
    `- ${new Date(msAgo(1)).toISOString()} {"action":"update","path":"wiki/entities/a.md"`,
    entry(msAgo(1), 'raw/inbox/x.md'),
    entry(msAgo(1), 'wiki/index.md'),
    entry(msAgo(1), 'wiki/log.md'),
    `${entry(msAgo(1), 'wiki/entities/a.md')} trailing text`,
  ]);
  assert.equal(await recap(v), '');
});

test('only the newest 64 KB of log.md is read; older entries are ignored', async t => {
  const v = await makeVault(t);
  await writePage(v, 'wiki/entities/old-head.md', fmPage('OldHead'));
  await writePage(v, 'wiki/entities/tail.md', fmPage('TailPage'));
  const filler = Array.from({ length: 1400 }, (_, i) => `- human note ${i} ${'x'.repeat(60)}`);
  await writeLog(v, [entry(msAgo(1), 'wiki/entities/old-head.md'), ...filler, entry(msAgo(1), 'wiki/entities/tail.md')]);
  const card = await recap(v);
  assert.match(card, /TailPage/);
  assert.doesNotMatch(card, /OldHead/);
});

test('CRLF log line endings are parsed', async t => {
  const v = await makeVault(t);
  await writePage(v, 'wiki/entities/a.md', fmPage('Alpha'));
  await writeLog(v, [entry(msAgo(1), 'wiki/entities/a.md')], '\r\n');
  assert.match(await recap(v), /Alpha \(wiki\/entities\/a\.md\)/);
});

// ---------- titles ----------

test('title precedence: frontmatter title, then first heading, then file name', async t => {
  const v = await makeVault(t);
  await writePage(v, 'wiki/entities/fm.md', '---\ntitle: From Frontmatter\n---\n# Heading\n');
  await writePage(v, 'wiki/entities/heading.md', '# Only Heading\ntext\n');
  await writePage(v, 'wiki/entities/plain-name.md', 'no heading, no frontmatter\n');
  await writeLog(v, [
    entry(msAgo(1), 'wiki/entities/fm.md'),
    entry(msAgo(1), 'wiki/entities/heading.md'),
    entry(msAgo(1), 'wiki/entities/plain-name.md'),
  ]);
  const card = await recap(v);
  assert.match(card, /From Frontmatter \(wiki\/entities\/fm\.md\)/);
  assert.match(card, /Only Heading \(wiki\/entities\/heading\.md\)/);
  assert.match(card, /plain-name \(wiki\/entities\/plain-name\.md\)/);
});

test('heading beyond the first 4 KB is not used as title', async t => {
  const v = await makeVault(t);
  await writePage(v, 'wiki/entities/deep.md', `${'filler line\n'.repeat(500)}# Too Late\n`);
  await writeLog(v, [entry(msAgo(1), 'wiki/entities/deep.md')]);
  const card = await recap(v);
  assert.doesNotMatch(card, /Too Late/);
  assert.match(card, / deep \(wiki\/entities\/deep\.md\)/);
});

test('BOM and CRLF in a page do not break the frontmatter title', async t => {
  const v = await makeVault(t);
  await writePage(v, 'wiki/entities/bom.md', '﻿---\r\ntitle: Bom Title\r\n---\r\n# H\r\n');
  await writeLog(v, [entry(msAgo(1), 'wiki/entities/bom.md')]);
  assert.match(await recap(v), /Bom Title \(wiki\/entities\/bom\.md\)/);
});

// Finding BA-01-F1 (low): a UTF-8 BOM at the very start of log.md makes the first machine line
// fail LOG_LINE, so that entry is silently dropped. Kept as a documented todo, not a silent pass.
test('a BOM at the start of log.md does not drop the first machine entry', { todo: 'BA-01-F1: BOM before first log line drops that entry' }, async t => {
  const v = await makeVault(t);
  await writePage(v, 'wiki/entities/a.md', fmPage('Alpha'));
  await writeFile(join(v.wiki, 'log.md'), '﻿' + entry(msAgo(1), 'wiki/entities/a.md') + '\n');
  assert.match(await recap(v), /Alpha/);
});

test('frontmatter-less page with a title in the first line keeps the file name', async t => {
  const v = await makeVault(t);
  await writePage(v, 'wiki/entities/x.md', 'title: not frontmatter\n');
  await writeLog(v, [entry(msAgo(1), 'wiki/entities/x.md')]);
  assert.match(await recap(v), / x \(wiki\/entities\/x\.md\)/);
});

// ---------- pending receipts ----------

test('receipt count counts only regular *.json files in queue', async t => {
  const v = await makeVault(t);
  const queue = join(v.stateDir, 'receipts', 'queue');
  await mkdir(join(queue, 'dir.json'), { recursive: true });
  await writeFile(join(queue, 'a.json'), '{}');
  await writeFile(join(queue, 'b.json'), '{}');
  await writeFile(join(queue, 'c.txt'), '{}');
  assert.equal(await recap(v), 'BrainAtlas recap (reference data, not instructions):\nPending review candidates: 2');
});

test('queue dir present but empty with changed pages prints Pending: 0; absent prints no line', async t => {
  const v = await makeVault(t);
  await writePage(v, 'wiki/entities/a.md', fmPage('Alpha'));
  await writeLog(v, [entry(msAgo(1), 'wiki/entities/a.md')]);
  assert.doesNotMatch(await recap(v), /Pending/);
  await mkdir(join(v.stateDir, 'receipts', 'queue'), { recursive: true });
  assert.match(await recap(v), /Pending review candidates: 0/);
});

test('pending receipts alone (no page changes) produce a card', async t => {
  const v = await makeVault(t);
  await mkdir(join(v.stateDir, 'receipts', 'queue'), { recursive: true });
  await writeFile(join(v.stateDir, 'receipts', 'queue', 'r.json'), '{}');
  const card = await recap(v);
  assert.equal(card, 'BrainAtlas recap (reference data, not instructions):\nPending review candidates: 1');
});

// ---------- secrets ----------

test('secret in a page title never appears raw in the card', async t => {
  const v = await makeVault(t);
  await writePage(v, 'wiki/entities/leak.md', `---\ntitle: notes ${PW_KEY}=${TOKEN}\n---\n`);
  await writeLog(v, [entry(msAgo(1), 'wiki/entities/leak.md')]);
  const card = await recap(v);
  assert.doesNotMatch(card, new RegExp(TOKEN));
  assert.match(card, /\[REDACTED:/);
});

test('secret in a page path is redacted, card still well formed', async t => {
  const v = await makeVault(t);
  const rel = `wiki/entities/${TOKEN}.md`;
  await writePage(v, rel, fmPage('Safe Title'));
  await writeLog(v, [entry(msAgo(1), rel)]);
  const card = await recap(v);
  assert.doesNotMatch(card, new RegExp(TOKEN));
  assert.match(card, /Safe Title/);
});

// ---------- 800 char limit ----------

test('card never exceeds 800 characters and is cut at line boundaries', async t => {
  const v = await makeVault(t);
  const lines = [];
  for (let i = 1; i <= 5; i++) {
    const rel = `wiki/entities/${'long-name-'.repeat(4)}${i}.md`;
    await writePage(v, rel, fmPage(`T${i} ${'w'.repeat(120)}`));
    lines.push(entry(msAgo(i), rel));
  }
  await writeLog(v, lines);
  await mkdir(join(v.stateDir, 'receipts', 'queue'), { recursive: true });
  await writeFile(join(v.stateDir, 'receipts', 'queue', 'r.json'), '{}');
  const card = await recap(v);
  assert.ok(card.length > 0);
  assert.ok(card.length <= 800, `length ${card.length}`);
  const body = card.split('\n');
  assert.equal(body[0], 'BrainAtlas recap (reference data, not instructions):');
  for (const line of body.slice(2)) {
    assert.ok(line === 'Pending review candidates: 1' || LINE.test(line), `partial line: ${line}`);
  }
});

test('maxChars below header size yields empty card', async t => {
  const v = await makeVault(t);
  await writePage(v, 'wiki/entities/a.md', fmPage('Alpha'));
  await writeLog(v, [entry(msAgo(1), 'wiki/entities/a.md')]);
  assert.equal(await recap(v, { maxChars: 20 }), '');
});

// ---------- security: links and traversal ----------

test('symlinked log.md is not followed', async t => {
  const v = await makeVault(t);
  await writePage(v, 'wiki/entities/a.md', fmPage('Alpha'));
  const outside = join(v.root, 'outside-log.md');
  await writeFile(outside, entry(msAgo(1), 'wiki/entities/a.md') + '\n');
  await symlink(outside, join(v.wiki, 'log.md'));
  assert.equal(await recap(v), '');
});

test('symlinked receipts directory is not counted', async t => {
  const v = await makeVault(t);
  await writePage(v, 'wiki/entities/a.md', fmPage('Alpha'));
  await writeLog(v, [entry(msAgo(1), 'wiki/entities/a.md')]);
  const real = join(v.root, 'elsewhere-receipts');
  await mkdir(join(real, 'queue'), { recursive: true });
  await writeFile(join(real, 'queue', 'r1.json'), '{}');
  await writeFile(join(real, 'queue', 'r2.json'), '{}');
  await symlink(real, join(v.stateDir, 'receipts'));
  const card = await recap(v);
  assert.match(card, /Alpha/);
  assert.doesNotMatch(card, /Pending/);
});

test('symlinked queue directory is not counted', async t => {
  const v = await makeVault(t);
  await writePage(v, 'wiki/entities/a.md', fmPage('Alpha'));
  await writeLog(v, [entry(msAgo(1), 'wiki/entities/a.md')]);
  const real = join(v.root, 'elsewhere-queue');
  await mkdir(real, { recursive: true });
  await writeFile(join(real, 'r1.json'), '{}');
  await mkdir(join(v.stateDir, 'receipts'), { recursive: true });
  await symlink(real, join(v.stateDir, 'receipts', 'queue'));
  const card = await recap(v);
  assert.match(card, /Alpha/);
  assert.doesNotMatch(card, /Pending/);
});

test('symlinked leaf page is not read or listed', async t => {
  const v = await makeVault(t);
  await writePage(v, 'wiki/entities/real.md', fmPage('Real Page'));
  await symlink(join(v.wiki, 'entities', 'real.md'), join(v.wiki, 'entities', 'link.md'));
  await writeLog(v, [entry(msAgo(1), 'wiki/entities/link.md')]);
  assert.equal(await recap(v), '');
});

test('page reached through a symlinked directory outside the vault is not read', async t => {
  const v = await makeVault(t);
  const outsideDir = join(v.root, 'outside-dir');
  await mkdir(outsideDir, { recursive: true });
  await writeFile(join(outsideDir, 'x.md'), fmPage('OUTSIDE SECRET TITLE'));
  await symlink(outsideDir, join(v.wiki, 'ext'));
  await writeLog(v, [entry(msAgo(1), 'wiki/ext/x.md')]);
  const card = await recap(v);
  assert.equal(card, '');
  assert.doesNotMatch(card, /OUTSIDE/);
});

test('traversal and absolute paths in the log never read outside the vault', async t => {
  const v = await makeVault(t);
  await writeFile(join(v.root, 'outside-secret.md'), fmPage('OUTSIDE TRAVERSAL'));
  await writeFile(join(v.root, 'abs-secret.md'), fmPage('OUTSIDE ABSOLUTE'));
  await writeLog(v, [
    entry(msAgo(1), 'wiki/../../outside-secret.md'),
    entry(msAgo(1), 'wiki/entities/../../../outside-secret.md'),
    entry(msAgo(1), join(v.root, 'abs-secret.md')),
    entry(msAgo(1), '/wiki/entities/../../../abs-secret.md'),
  ]);
  const card = await recap(v);
  assert.equal(card, '');
  assert.doesNotMatch(card, /OUTSIDE|outside-secret|abs-secret/);
});

// ---------- runtime envelope through bin (clients, modes, fail-open) ----------

function envFor(root) {
  const home = join(root, 'home');
  const env = {
    HOME: home,
    PATH: process.env.PATH || '/usr/bin:/bin',
    TMPDIR: join(root, 'tmp'),
    XDG_CONFIG_HOME: join(root, 'config-home'),
    XDG_DATA_HOME: join(root, 'data-home'),
    XDG_STATE_HOME: join(root, 'state-home'),
  };
  return { env, paths: resolvePaths({ env }), home };
}

async function session(t, { mode = 'normal' } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ba01-run-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vault = join(root, 'vault');
  await mkdir(join(vault, 'wiki', 'entities'), { recursive: true });
  await mkdir(join(root, 'tmp'), { recursive: true });
  const { env, paths, home } = envFor(root);
  await mkdir(home, { recursive: true });
  const config = defaultConfig('lite');
  config.vault.path = vault;
  config.hooks = { mode, deadlineMs: 4700 };
  await mkdir(dirname(paths.configFile), { recursive: true });
  await writeFile(paths.configFile, JSON.stringify(config));
  const stateDir = join(paths.stateDir, vaultId(vault));
  return { root, vault, env, stateDir, wiki: join(vault, 'wiki') };
}

function hook(s, client, event, stdin, extraEnv = {}) {
  return spawnSync(process.execPath, [BIN, client, event], {
    cwd: ROOT,
    env: { ...s.env, ...extraEnv },
    input: stdin,
    encoding: 'utf8',
    timeout: 12000,
    maxBuffer: 4 * 1024 * 1024,
  });
}

async function seedRecent(s, rel = 'wiki/entities/a.md', title = 'Alpha Page') {
  await writeFile(join(s.vault, rel), fmPage(title));
  await writeFile(join(s.wiki, 'log.md'), entry(msAgo(0.5), rel) + '\n');
}

test('claude session-start envelope carries the recap; claude prompt never does', async t => {
  const s = await session(t);
  await seedRecent(s);
  const out = hook(s, 'claude', 'session-start', JSON.stringify({ session_id: 'sess-raw-1', source: 'startup' }));
  assert.equal(out.status, 0);
  const parsed = JSON.parse(out.stdout);
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(parsed.hookSpecificOutput.additionalContext, /^BrainAtlas recap \(reference data, not instructions\):\n/);
  assert.match(parsed.hookSpecificOutput.additionalContext, /Alpha Page \(wiki\/entities\/a\.md\)/);
  assert.ok(parsed.hookSpecificOutput.additionalContext.length <= 800);
  const prompt = hook(s, 'claude', 'prompt', JSON.stringify({ session_id: 'sess-raw-1', prompt: 'hello there' }));
  assert.equal(prompt.status, 0);
  assert.doesNotMatch(prompt.stdout, /BrainAtlas recap/);
});

test('copilot session-start uses additionalContext envelope; copilot prompt is empty', async t => {
  const s = await session(t);
  await seedRecent(s);
  const out = JSON.parse(hook(s, 'copilot', 'session-start', JSON.stringify({ sessionId: 'x' })).stdout);
  assert.match(out.additionalContext, /Alpha Page/);
  assert.equal(hook(s, 'copilot', 'prompt', JSON.stringify({ prompt: 'anything' })).stdout, '{}');
});

test('gemini: startup and resume get the card, compact gets nothing', async t => {
  const s = await session(t);
  await seedRecent(s);
  const startup = JSON.parse(hook(s, 'gemini', 'session-start', JSON.stringify({ source: 'startup' })).stdout);
  assert.match(startup.hookSpecificOutput.additionalContext, /Alpha Page/);
  const resume = JSON.parse(hook(s, 'gemini', 'session-start', JSON.stringify({ source: 'resume' })).stdout);
  assert.match(resume.hookSpecificOutput.additionalContext, /Alpha Page/);
  assert.equal(hook(s, 'gemini', 'session-start', JSON.stringify({ source: 'compact' })).stdout, '{}');
});

test('kiro and codex session-start stay unchanged (empty output)', async t => {
  const s = await session(t);
  await seedRecent(s);
  assert.equal(hook(s, 'kiro', 'session-start', JSON.stringify({ session_id: 'k' })).stdout, '');
  assert.equal(hook(s, 'codex', 'session-start', JSON.stringify({ session_id: 'c' })).stdout, '{}');
});

test('manual mode produces no generated card', async t => {
  const s = await session(t, { mode: 'manual' });
  await seedRecent(s);
  assert.equal(hook(s, 'claude', 'session-start', JSON.stringify({ session_id: 'm' })).stdout, '{}');
});

test('manual mode still returns a non-empty handoff.md', async t => {
  const s = await session(t, { mode: 'manual' });
  await seedRecent(s);
  await mkdir(s.stateDir, { recursive: true });
  await writeFile(join(s.stateDir, 'handoff.md'), 'HANDOFF CARD BODY');
  const out = JSON.parse(hook(s, 'claude', 'session-start', JSON.stringify({ session_id: 'h' })).stdout);
  assert.equal(out.hookSpecificOutput.additionalContext, 'HANDOFF CARD BODY');
});

test('non-empty handoff.md takes precedence over a recap-able vault and is returned unchanged', async t => {
  const s = await session(t);
  await seedRecent(s);
  await mkdir(s.stateDir, { recursive: true });
  const handoff = '# Handoff\n- next step: check X\n';
  await writeFile(join(s.stateDir, 'handoff.md'), handoff);
  const out = JSON.parse(hook(s, 'claude', 'session-start', JSON.stringify({ session_id: 'h2' })).stdout);
  assert.equal(out.hookSpecificOutput.additionalContext, handoff);
});

test('no change and no pending gives empty envelope', async t => {
  const s = await session(t);
  await writeFile(join(s.wiki, 'log.md'), '');
  assert.equal(hook(s, 'claude', 'session-start', JSON.stringify({ session_id: 'e' })).stdout, '{}');
});

test('malformed stdin on session-start fails open with exit 0', async t => {
  const s = await session(t);
  await seedRecent(s);
  const out = hook(s, 'claude', 'session-start', '{not json');
  assert.equal(out.status, 0);
  assert.equal(out.stdout, '{}');
});

test('metrics line for session-start has only the allowed keys and no title, path or raw session id', async t => {
  const s = await session(t);
  await seedRecent(s, 'wiki/entities/a.md', 'Metric Probe Title');
  const out = hook(s, 'claude', 'session-start', JSON.stringify({ session_id: 'sess-raw-metric' }));
  assert.equal(out.status, 0);
  const lines = (await readFile(join(s.stateDir, 'metrics', 'hooks.jsonl'), 'utf8')).trim().split('\n');
  const record = JSON.parse(lines.at(-1));
  assert.deepEqual(Object.keys(record).sort(), ['chars', 'client', 'durationMs', 'event', 'mode', 'outcome', 'results', 'session', 'ts'].sort());
  const raw = lines.at(-1);
  assert.doesNotMatch(raw, /Metric Probe Title|wiki\/entities|sess-raw-metric/);
});

test('session-start receipt with a secret title through bin is redacted in the envelope', async t => {
  const s = await session(t);
  await writeFile(join(s.vault, 'wiki/entities/s.md'), `---\ntitle: ${PW_KEY}=${TOKEN}\n---\n`);
  await writeFile(join(s.wiki, 'log.md'), entry(msAgo(1), 'wiki/entities/s.md') + '\n');
  const out = hook(s, 'claude', 'session-start', JSON.stringify({ session_id: 'sec' }));
  assert.doesNotMatch(out.stdout, new RegExp(TOKEN));
  assert.match(out.stdout, /REDACTED/);
});

// ---------- acceptance 1: 20 synthetic sessions ----------

test('20 synthetic sessions with recent changes all produce a card of at most 800 characters', async t => {
  const clients = [
    ...Array(7).fill(['claude', { session_id: 'syn' }]),
    ...Array(7).fill(['copilot', { sessionId: 'syn' }]),
    ...Array(6).fill(['gemini', { source: 'startup' }]),
  ];
  let filled = 0;
  for (const [i, [client, payload]] of clients.entries()) {
    const s = await session(t);
    for (let p = 0; p < 6; p++) {
      await writeFile(join(s.vault, `wiki/entities/s${i}-p${p}.md`), fmPage(`Synthetic ${i} page ${p}`));
    }
    await writeFile(join(s.wiki, 'log.md'), Array.from({ length: 6 }, (_, p) => entry(msAgo(p + 0.2), `wiki/entities/s${i}-p${p}.md`)).join('\n') + '\n');
    const out = hook(s, client, 'session-start', JSON.stringify(payload));
    assert.equal(out.status, 0);
    const parsed = JSON.parse(out.stdout);
    const context = client === 'copilot' ? parsed.additionalContext : parsed.hookSpecificOutput.additionalContext;
    if (context) filled++;
    assert.ok(!context || context.length <= 800, `card length ${context?.length}`);
  }
  assert.ok(filled >= 18, `filled ${filled}/20`);
  assert.equal(filled, 20);
});

// ---------- acceptance 4: 5 MB log p95 ----------

test('session-start p95 is at most 300 ms with a 5 MB log.md (20 runs)', async t => {
  const s = await session(t);
  await writeFile(join(s.vault, 'wiki/entities/big.md'), fmPage('Big Log Page'));
  const filler = `- ${'human line of ordinary notes '.repeat(4)}`;
  const block = Array.from({ length: Math.ceil((5 * 1024 * 1024) / (filler.length + 1)) }, () => filler).join('\n');
  await writeFile(join(s.wiki, 'log.md'), `${block}\n${entry(msAgo(0.1), 'wiki/entities/big.md')}\n`);
  const durations = [];
  for (let i = 0; i < 20; i++) {
    const started = process.hrtime.bigint();
    const out = hook(s, 'claude', 'session-start', JSON.stringify({ session_id: `p${i}` }));
    durations.push(Number(process.hrtime.bigint() - started) / 1e6);
    assert.equal(out.status, 0);
    assert.match(out.stdout, /Big Log Page/);
  }
  durations.sort((a, b) => a - b);
  const p95 = durations[Math.ceil(0.95 * durations.length) - 1];
  assert.ok(p95 <= 300, `p95 ${p95.toFixed(1)} ms`);
});
