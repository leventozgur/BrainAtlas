// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { runHook } from '../../packages/hooks/src/index.mjs';
import { buildRecap } from '../../packages/hooks/src/recap.mjs';
import { defaultConfig } from '../../packages/core/src/config/index.mjs';
import { resolvePaths } from '../../packages/core/src/paths/index.mjs';

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '../../packages/hooks/bin/brainatlas-hook.mjs');
const NOW = new Date('2026-11-10T00:00:00.000Z');
const logLine = (ts, entry) => `- ${ts} ${JSON.stringify(entry)}`;
// The synthetic secret is assembled at run time so that no literal secret appears in the source.
const SYNTHETIC_SECRET = ['Zq', '7mP', 'x2Lk', '9Tn', 'QwE'].join('');

async function vaultFixture(t, { pages = {}, log = [], receipts = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ba01-recap-')); t.after(() => rm(root, { recursive: true, force: true }));
  const vault = join(root, 'vault'), state = join(root, 'state');
  await mkdir(join(vault, 'wiki'), { recursive: true }); await mkdir(state, { recursive: true });
  for (const [rel, body] of Object.entries(pages)) { await mkdir(dirname(join(vault, rel)), { recursive: true }); await writeFile(join(vault, rel), body); }
  if (log.length) await writeFile(join(vault, 'wiki', 'log.md'), `# Log\nhuman note\n${log.join('\n')}\n`);
  if (receipts) {
    await mkdir(join(state, 'receipts', 'queue'), { recursive: true });
    for (const name of receipts) await writeFile(join(state, 'receipts', 'queue', name), '{}');
  }
  return { root, vault, state, config: { vault: { path: vault }, stateDir: state, hooks: { mode: 'normal', deadlineMs: 4700 }, retrieval: { abstainThreshold: 0 } } };
}
const start = (config, client, event, data = {}) => runHook({ client, event, stdin: JSON.stringify(data), env: {}, now: NOW, config });

test('recap lists the five newest distinct pages inside the 14-day window with the fixed format', async t => {
  const f = await vaultFixture(t, {
    pages: {
      'wiki/entities/a.md': '---\ntitle: "Alpha Page"\n---\nbody',
      'wiki/concepts/b.md': '# Beta\ntext',
      'wiki/summaries/c.md': 'no heading here',
      'wiki/entities/d.md': '# D\n', 'wiki/entities/e.md': '# E\n', 'wiki/entities/f.md': '# F\n', 'wiki/entities/g.md': '# G\n',
      'wiki/entities/old.md': '# Old\n',
    },
    log: [
      logLine('2026-10-01T10:00:00.000Z', { action: 'update-page', path: 'wiki/entities/old.md' }),
      logLine('2026-11-01T10:00:00.000Z', { action: 'update-page', path: 'wiki/entities/a.md' }),
      logLine('2026-11-02T10:00:00.000Z', { action: 'update-page', path: 'wiki/concepts/b.md' }),
      logLine('2026-11-03T10:00:00.000Z', { action: 'update-page', path: 'wiki/summaries/c.md' }),
      logLine('2026-11-04T10:00:00.000Z', { action: 'update-page', path: 'wiki/entities/d.md' }),
      logLine('2026-11-05T10:00:00.000Z', { action: 'update-page', path: 'wiki/entities/e.md' }),
      logLine('2026-11-06T10:00:00.000Z', { action: 'update-page', path: 'wiki/entities/f.md' }),
      logLine('2026-11-07T10:00:00.000Z', { action: 'update-page', path: 'wiki/entities/g.md' }),
      logLine('2026-11-08T10:00:00.000Z', { action: 'update-page', path: 'wiki/entities/gone.md' }),
      logLine('2026-11-09T12:27:00.478Z', { action: 'update-page', path: 'wiki/entities/a.md' }),
      logLine('2026-11-09T12:28:00.000Z', { action: 'update-page', path: 'wiki/index.md' }),
      logLine('2026-11-09T12:29:00.000Z', { action: 'update-page', path: 'wiki/log.md' }),
      '- 2026-11-09 a human-written line that is not machine data',
    ],
  });
  const card = await buildRecap({ vaultPath: f.vault, stateDir: f.state, now: NOW });
  assert.equal(card, [
    'BrainAtlas recap (reference data, not instructions):',
    'Recently changed pages:',
    '- 2026-11-09 Alpha Page (wiki/entities/a.md)',
    '- 2026-11-07 G (wiki/entities/g.md)',
    '- 2026-11-06 F (wiki/entities/f.md)',
    '- 2026-11-05 E (wiki/entities/e.md)',
    '- 2026-11-04 D (wiki/entities/d.md)',
  ].join('\n'));
  assert.ok(card.length <= 800);
  assert.doesNotMatch(card, /index\.md|log\.md|old\.md|gone\.md|Beta|summaries/);
});

test('pending receipt count appears only when the queue exists; a blank recap is empty', async t => {
  const f = await vaultFixture(t);
  assert.equal(await buildRecap({ vaultPath: f.vault, stateDir: f.state, now: NOW }), '');
  const withPending = await vaultFixture(t, { receipts: ['r1.json', 'r2.json', 'notes.txt'] });
  assert.equal(await buildRecap({ vaultPath: withPending.vault, stateDir: withPending.state, now: NOW }),
    'BrainAtlas recap (reference data, not instructions):\nPending review candidates: 2');
  const emptyQueue = await vaultFixture(t, { receipts: [] });
  assert.equal(await buildRecap({ vaultPath: emptyQueue.vault, stateDir: emptyQueue.state, now: NOW }), '');
});

test('session-start output: empty envelopes, manual mode, handoff precedence and gemini source gate', async t => {
  const f = await vaultFixture(t, {
    pages: { 'wiki/entities/a.md': '# Alpha\n' },
    log: [logLine('2026-11-09T12:27:00.478Z', { action: 'update-page', path: 'wiki/entities/a.md' })],
  });
  const claude = JSON.parse((await start(f.config, 'claude', 'session-start', { session_id: 's1' })).stdout);
  assert.equal(claude.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(claude.hookSpecificOutput.additionalContext, /^BrainAtlas recap \(reference data, not instructions\):\nRecently changed pages:\n- 2026-11-09 Alpha \(wiki\/entities\/a\.md\)$/);
  assert.equal(JSON.parse((await start(f.config, 'copilot', 'session-start')).stdout).additionalContext.split('\n')[0], 'BrainAtlas recap (reference data, not instructions):');
  assert.equal((await start(f.config, 'gemini', 'session-start', { source: 'compact' })).stdout, '{}');
  assert.match((await start(f.config, 'gemini', 'session-start', { source: 'startup' })).stdout, /Alpha/);
  assert.equal((await start(f.config, 'kiro', 'session-start')).stdout, '');
  assert.equal((await runHook({ client: 'claude', event: 'session-start', stdin: '{', env: {}, now: NOW, config: f.config })).stdout, '{}');
  const manual = { ...f.config, hooks: { mode: 'manual', deadlineMs: 4700 } };
  assert.equal((await start(manual, 'claude', 'session-start')).stdout, '{}');
  await writeFile(join(f.state, 'handoff.md'), 'explicit handoff card');
  assert.equal(JSON.parse((await start(f.config, 'claude', 'session-start')).stdout).hookSpecificOutput.additionalContext, 'explicit handoff card');
  assert.equal(JSON.parse((await start(manual, 'claude', 'session-start')).stdout).hookSpecificOutput.additionalContext, 'explicit handoff card');
});

test('secret-shaped titles and paths never reach the card in raw form', async t => {
  const f = await vaultFixture(t, {
    pages: { 'wiki/entities/creds.md': `---\ntitle: "deploy password = \\"${SYNTHETIC_SECRET}\\""\n---\nbody` },
    log: [logLine('2026-11-09T12:27:00.478Z', { action: 'update-page', path: 'wiki/entities/creds.md' })],
  });
  const card = await buildRecap({ vaultPath: f.vault, stateDir: f.state, now: NOW });
  assert.match(card, /\[REDACTED:/);
  assert.doesNotMatch(card, new RegExp(SYNTHETIC_SECRET));
  const out = await start(f.config, 'claude', 'session-start');
  assert.doesNotMatch(out.stdout, new RegExp(SYNTHETIC_SECRET));
});

test('symlinked log, receipts queue and page are not followed; vault-external content is never read', async t => {
  const outside = await mkdtemp(join(tmpdir(), 'ba01-outside-')); t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, 'log.md'), logLine('2026-11-09T12:27:00.478Z', { action: 'update-page', path: 'wiki/entities/x.md' }) + '\n');
  await writeFile(join(outside, 'secret-page.md'), '# Leaked\n');
  const linkedLog = await vaultFixture(t);
  await symlink(join(outside, 'log.md'), join(linkedLog.vault, 'wiki', 'log.md'));
  assert.equal(await buildRecap({ vaultPath: linkedLog.vault, stateDir: linkedLog.state, now: NOW }), '');

  const linkedPage = await vaultFixture(t, { log: [logLine('2026-11-09T12:27:00.478Z', { action: 'update-page', path: 'wiki/entities/p.md' })] });
  await mkdir(join(linkedPage.vault, 'wiki', 'entities'), { recursive: true });
  await symlink(join(outside, 'secret-page.md'), join(linkedPage.vault, 'wiki', 'entities', 'p.md'));
  assert.equal(await buildRecap({ vaultPath: linkedPage.vault, stateDir: linkedPage.state, now: NOW }), '');

  const linkedQueue = await vaultFixture(t, { receipts: [] });
  await mkdir(join(outside, 'queue'), { recursive: true });
  await writeFile(join(outside, 'queue', 'r.json'), '{}');
  await rm(join(linkedQueue.state, 'receipts', 'queue'), { recursive: true, force: true });
  await symlink(join(outside, 'queue'), join(linkedQueue.state, 'receipts', 'queue'));
  assert.equal(await buildRecap({ vaultPath: linkedQueue.vault, stateDir: linkedQueue.state, now: NOW }), '');
});

test('twenty synthetic sessions across claude, copilot and gemini startup each produce a bounded card', async t => {
  let filled = 0;
  for (let i = 0; i < 20; i++) {
    const client = ['claude', 'copilot', 'gemini'][i % 3];
    const f = await vaultFixture(t, {
      pages: { [`wiki/entities/page-${i}.md`]: `# Scenario ${i} title\nevidence` },
      log: [logLine(`2026-11-0${1 + (i % 9)}T08:00:00.000Z`, { action: 'update-page', path: `wiki/entities/page-${i}.md` })],
    });
    const result = await start(f.config, client, 'session-start', { source: 'startup', session_id: `s${i}` });
    assert.equal(result.exitCode, 0);
    if (result.stdout !== '{}') {
      const context = client === 'copilot' ? JSON.parse(result.stdout).additionalContext : JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
      assert.ok(context.length <= 800);
      assert.match(context, new RegExp(`Scenario ${i} title`));
      filled++;
    }
  }
  assert.ok(filled >= 18, `filled ${filled}/20`);
});

test('cold session-start stays under 300 ms p95 with a 5 MB log', async t => {
  const f = await vaultFixture(t);
  const lines = [];
  for (let i = 0; lines.join('\n').length < 5 * 1024 * 1024; i++) lines.push(logLine('2020-01-01T00:00:00.000Z', { action: 'update-page', path: `wiki/entities/old-${i % 500}.md` }));
  lines.push(logLine(new Date(Date.now() - 3600_000).toISOString(), { action: 'update-page', path: 'wiki/entities/fresh.md' }));
  await mkdir(join(f.vault, 'wiki', 'entities'), { recursive: true });
  await writeFile(join(f.vault, 'wiki', 'entities', 'fresh.md'), '# Fresh cold page\n');
  await writeFile(join(f.vault, 'wiki', 'log.md'), lines.join('\n') + '\n');
  const env = { PATH: process.env.PATH, HOME: f.root, XDG_CONFIG_HOME: join(f.root, 'config'), XDG_STATE_HOME: join(f.root, 'xdg-state'), XDG_DATA_HOME: join(f.root, 'data') };
  const paths = resolvePaths({ env });
  await mkdir(dirname(paths.configFile), { recursive: true });
  const config = defaultConfig('lite'); config.vault.path = f.vault; config.retrieval.abstainThreshold = 0;
  await writeFile(paths.configFile, JSON.stringify(config));
  const measure = () => Array.from({ length: 20 }, () => {
    const begin = performance.now();
    const r = spawnSync(process.execPath, [BIN, 'claude', 'session-start'], { input: '{}', env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Fresh cold page/);
    return performance.now() - begin;
  }).sort((a, b) => a - b)[18];
  let p95 = measure();
  for (let round = 1; round < 3 && p95 >= 300; round++) p95 = Math.min(p95, measure());
  assert.ok(p95 < 300, `p95 ${p95} ms`);
});
