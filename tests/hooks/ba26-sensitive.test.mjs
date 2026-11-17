// SPDX-License-Identifier: MIT
// BA-26: the hook never injects a page with `sensitivity: personal` or `inject: never`, never marks it as shown, and redacts
// contact data and checksum-valid personal identifiers in its output. Pages without these markers are unchanged.
// Hermetic: temporary vault, state and HOME directories only; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHook } from '../../packages/hooks/src/index.mjs';

const NOW = new Date('2026-11-10T00:00:00Z');
const logLine = (ts, entry) => `- ${ts} ${JSON.stringify(entry)}`;
// Synthetic values assembled at run time; the TCKN and IBAN check digits are computed here.
const MAIL = ['ornek.kisi', '@', 'example.com'].join('');
const PHONE = '+90 ' + '5' + '32 000 00 00';
function tckn(first9) {
  const d = [...first9].map(Number);
  const odd = d[0] + d[2] + d[4] + d[6] + d[8],
    even = d[1] + d[3] + d[5] + d[7];
  const d10 = (((odd * 7 - even) % 10) + 10) % 10;
  return `${first9}${d10}${[...d, d10].reduce((a, b) => a + b, 0) % 10}`;
}
const TCKN = tckn('123456789');

async function fixture(t, pages, log = []) {
  const root = await mkdtemp(join(tmpdir(), 'ba26-hooks-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vault = join(root, 'vault'),
    state = join(root, 'state'),
    home = join(root, 'home');
  await Promise.all([mkdir(join(vault, 'wiki'), { recursive: true }), mkdir(state), mkdir(home)]);
  for (const [name, body] of Object.entries(pages)) {
    await mkdir(join(vault, name, '..'), { recursive: true });
    await writeFile(join(vault, name), body);
  }
  if (log.length) await writeFile(join(vault, 'wiki', 'log.md'), `# Log\n${log.join('\n')}\n`);
  return {
    vault,
    state,
    env: { HOME: home },
    config: {
      vault: { path: vault },
      stateDir: state,
      hooks: { mode: 'normal', deadlineMs: 4700 },
      retrieval: { abstainThreshold: 0 },
    },
  };
}
async function ask(f, prompt, session) {
  const r = await runHook({
    client: 'claude',
    event: 'prompt',
    stdin: JSON.stringify({ session_id: session, prompt }),
    env: f.env,
    config: f.config,
    now: NOW,
  });
  assert.equal(r.exitCode, 0);
  if (r.stdout === '{}') return '';
  return JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
}
async function seenStates(state) {
  const dir = join(state, 'hooks');
  const names = await readdir(dir).catch(() => []);
  return (
    await Promise.all(names.filter((n) => n.endsWith('.json')).map(async (n) => readFile(join(dir, n), 'utf8')))
  ).join('\n');
}

const pages = {
  'wiki/plain.md': '---\nstatus: draft\n---\n# Plain Note\n\nzebrafish plain note text.\n',
  'wiki/personal.md': '---\nsensitivity: personal\n---\n# Family Note\n\nzebrafish family note text.\n',
  'wiki/never.md': '---\ninject: never\n---\n# Never Note\n\nzebrafish never note text.\n',
};

test('BA-26: personal and never-inject pages are not injected and not marked as shown; the plain page is', async (t) => {
  const f = await fixture(t, pages);
  const context = await ask(f, 'zebrafish', 'ba26-sensitive');
  assert.match(context, /Plain Note \(wiki\/plain\.md\)/);
  assert.ok(!context.includes('Family Note'), context);
  assert.ok(!context.includes('Never Note'), context);
  assert.ok(!context.includes('wiki/personal.md') && !context.includes('wiki/never.md'), context);
  const state = await seenStates(f.state);
  assert.match(state, /wiki\/plain\.md/);
  assert.ok(!state.includes('wiki/personal.md') && !state.includes('wiki/never.md'), state);
});

test('BA-26: a restricted page is still retrievable by the lexical search of the MCP path', async (t) => {
  const f = await fixture(t, pages);
  const { createSearcher } = await import('../../packages/core/src/retrieval/index.mjs');
  const searcher = createSearcher({ vaultDir: f.vault, stateDir: f.state, now: NOW });
  const paths = searcher.search('zebrafish', { limit: 10, abstainThreshold: 0 }).results.map((r) => r.path);
  assert.ok(paths.includes('wiki/personal.md') && paths.includes('wiki/never.md'), paths.join(','));
});

test('BA-26: e-mail and TR phone numbers in injected text are redacted; checksum-valid TCKN is redacted', async (t) => {
  const f = await fixture(t, {
    'wiki/contact.md': `# Contact Card\n\nzebrafish contact: ${MAIL}, ${PHONE}, kimlik ${TCKN}.\n`,
  });
  const context = await ask(f, 'zebrafish', 'ba26-contact');
  assert.match(context, /\[REDACTED:email\]/);
  assert.match(context, /\[REDACTED:tr-phone\]/);
  assert.match(context, /\[REDACTED:tckn\]/);
  assert.ok(!context.includes(MAIL) && !context.includes('532 000') && !context.includes(TCKN), context);
});

test('BA-26: a page without the restriction keeps the previous output byte for byte', async (t) => {
  const f = await fixture(t, { 'wiki/topic.md': '# Topic\nzebrafish topic evidence' });
  const context = await ask(f, 'zebrafish', 'ba26-legacy');
  assert.equal(context, 'Topic (wiki/topic.md)\n# Topic\nzebrafish topic evidence');
});

test('BA-26: the session-start recap omits restricted pages and keeps the others', async (t) => {
  const log = [
    logLine('2026-11-09T12:00:00.000Z', { action: 'update-page', path: 'wiki/personal.md' }),
    logLine('2026-11-09T12:01:00.000Z', { action: 'update-page', path: 'wiki/never.md' }),
    logLine('2026-11-09T12:02:00.000Z', { action: 'update-page', path: 'wiki/plain.md' }),
  ];
  const f = await fixture(t, pages, log);
  const r = await runHook({
    client: 'claude',
    event: 'session-start',
    stdin: JSON.stringify({ session_id: 'ba26-recap', source: 'startup' }),
    env: f.env,
    config: f.config,
    now: NOW,
  });
  const context = JSON.parse(r.stdout).hookSpecificOutput?.additionalContext ?? '';
  assert.match(context, /wiki\/plain\.md/, context);
  assert.ok(!context.includes('Family Note') && !context.includes('wiki/personal.md'), context);
  assert.ok(!context.includes('Never Note') && !context.includes('wiki/never.md'), context);
});
