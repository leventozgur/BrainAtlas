// SPDX-License-Identifier: MIT
// BA-56: data egress protection for the BA-48 synthesis path. Restricted pages never reach the model, the prompt and the
// model output are secret-scanned, state files are private, offline skips the model and accept stays inside the
// configured vault. Every model call is faked; no network and no real model is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig, resolvePaths, saveConfig, setConfigValue } from '../../packages/core/src/index.mjs';
import { main } from '../../packages/cli/src/index.mjs';
import { runMaintenance } from '../../packages/cli/src/maintain.mjs';
import { scorePages } from '../../packages/cli/src/synthesis/core.mjs';
import { proposeCurrentState } from '../../packages/cli/src/synthesis/propose.mjs';
import { cleanEnv } from './clean-env.mjs';

const NOW = new Date('2026-11-18T00:00:00.000Z');
const OLD = new Date('2026-10-01T00:00:00.000Z');
const OPEN = 'wiki/concepts/open.md';
const SECRET = 'sk-ant-abcdefghijklmnopqrstuvwxyz0123456789';

async function temp(t, prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const updates = (count) =>
  Array.from(
    { length: count },
    (_, index) => `\n## Update 2026-01-${String(index + 1).padStart(2, '0')}\n\nA dated note ${index + 1}.\n`
  ).join('');

const pageText = (title, extra, body) =>
  [
    '---',
    'type: concept',
    `title: ${title}`,
    'status: confirmed',
    'verified: []',
    'sources: []',
    'stale_after: "2020-01-01"',
    ...(extra ? [extra] : []),
    '---',
    body,
  ].join('\n');

const openBody = `# Open page\n\nThe open page holds the OPEN-BODY-MARKER value.\n`;
const restrictedBody = `# Restricted page\n\nThe restricted page holds the RESTRICTED-BODY-MARKER value.\n${updates(12)}`;

/** A vault whose pages are all older than seven days, so none counts as recently edited. */
async function vaultWith(t, pages) {
  const root = await temp(t, 'ba56-vault-');
  const vault = join(root, 'vault');
  await mkdir(join(vault, 'wiki', 'concepts'), { recursive: true });
  const index = ['# Wiki Index', '', '## Concepts', ''];
  for (const spec of pages) {
    const file = join(vault, spec.path);
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, spec.text);
    await utimes(file, OLD, OLD);
    index.push(`- [${spec.title}](${spec.path.slice('wiki/'.length)})`);
  }
  const indexFile = join(vault, 'wiki', 'index.md');
  await writeFile(indexFile, `${index.join('\n')}\n`);
  await utimes(indexFile, OLD, OLD);
  return vault;
}

function faking(calls, stdout) {
  return async (command, args, options) => {
    calls.push({ command, args, input: options.input });
    return { code: 0, stdout: typeof stdout === 'function' ? stdout(calls.length) : stdout, stderr: '' };
  };
}

const configOf = (synthesis = {}) => ({
  maintain: { synthesis: { mode: 'shadow', command: ['fake-model'], pagesPerWeek: 1, ...synthesis } },
});

const openProposal = (page = OPEN) => {
  const quote = 'The open page holds the OPEN-BODY-MARKER value.';
  return JSON.stringify({
    schemaVersion: 1,
    page,
    sentences: [{ text: quote, anchors: [{ source: 'page', quote }] }],
    conflicts: [],
  });
};

const recordFiles = async (stateDir) =>
  readdir(join(stateDir, 'synthesis', 'proposals')).catch((error) => {
    if (error?.code === 'ENOENT') return [];
    throw error;
  });

test('a restricted higher-scored page is excluded from the target slot', async (t) => {
  const variants = [
    ['sensitivity personal', 'sensitivity: personal'],
    ['sensitivity padded and upper case', 'sensitivity: " Personal "'],
    ['inject never', 'inject: never'],
    ['inject padded and upper case', 'inject: " NEVER "'],
  ];
  for (const [label, extra] of variants) {
    const vault = await vaultWith(t, [
      { path: 'wiki/concepts/restricted.md', title: 'Restricted', text: pageText('Restricted', extra, restrictedBody) },
      { path: OPEN, title: 'Open', text: pageText('Open', '', openBody) },
    ]);
    if (label === 'sensitivity personal') {
      // The fixture ranks the restricted page first, so the excluded slot is the meaningful one.
      const scored = await scorePages(vault, { now: NOW, report: await runMaintenance(vault, { now: NOW }) });
      assert.equal(scored[0].path, 'wiki/concepts/restricted.md');
    }
    const stateDir = await temp(t, 'ba56-state-');
    const calls = [];
    const result = await proposeCurrentState({
      vault,
      config: configOf(),
      stateDir,
      now: NOW,
      runCommand: faking(calls, openProposal()),
    });
    assert.equal(calls.length, 1, label);
    assert.ok(calls[0].input.includes('OPEN-BODY-MARKER'), label);
    assert.equal(calls[0].input.includes('RESTRICTED-BODY-MARKER'), false, label);
    assert.equal(calls[0].input.includes('A dated note'), false, label);
    assert.equal(result.excluded, 1, label);
    assert.equal(result.proposals.length, 1, label);
    assert.equal(result.proposals[0].page, OPEN, label);
  }
});

test('a page with unparsable frontmatter is excluded while a page without frontmatter is not', async (t) => {
  const broken = [
    '---',
    'type: concept',
    'title: Broken',
    'sensitivity: personal',
    'sensitivity: personal',
    '---',
    restrictedBody,
  ].join('\n');
  const vault = await vaultWith(t, [
    { path: 'wiki/concepts/broken.md', title: 'Broken', text: broken },
    { path: OPEN, title: 'Open', text: pageText('Open', '', openBody) },
  ]);
  const scored = await scorePages(vault, { now: NOW, report: await runMaintenance(vault, { now: NOW }) });
  assert.equal(scored[0].path, 'wiki/concepts/broken.md');

  const stateDir = await temp(t, 'ba56-state-');
  const calls = [];
  const result = await proposeCurrentState({
    vault,
    config: configOf(),
    stateDir,
    now: NOW,
    runCommand: faking(calls, openProposal()),
  });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].input.includes('OPEN-BODY-MARKER'));
  assert.equal(calls[0].input.includes('RESTRICTED-BODY-MARKER'), false);
  assert.equal(result.excluded, 1);
  assert.equal(result.proposals.length, 1);
  assert.equal(result.proposals[0].page, OPEN);

  const bareBody = `# Bare page\n\nThe bare page holds the BARE-BODY-MARKER value.\n${updates(12)}`;
  const bareVault = await vaultWith(t, [{ path: OPEN, title: 'Open', text: bareBody }]);
  const bareState = await temp(t, 'ba56-state-');
  const bareCalls = [];
  const bare = await proposeCurrentState({
    vault: bareVault,
    config: configOf(),
    stateDir: bareState,
    now: NOW,
    runCommand: faking(bareCalls, () =>
      JSON.stringify({
        schemaVersion: 1,
        page: OPEN,
        sentences: [
          {
            text: 'The bare page holds the BARE-BODY-MARKER value.',
            anchors: [{ source: 'page', quote: 'The bare page holds the BARE-BODY-MARKER value.' }],
          },
        ],
        conflicts: [],
      })
    ),
  });
  assert.equal(bareCalls.length, 1);
  assert.equal(bare.excluded, undefined);
  assert.equal(bare.proposals.length, 1);
});

test('a prompt with a secret is skipped as unsafe-input without a call, ledger or record', async (t) => {
  const vault = await vaultWith(t, [
    {
      path: OPEN,
      title: 'Open',
      text: pageText('Open', '', `# Leaky page\n\nThe leaky page stores ${SECRET} in its body.\n`),
    },
  ]);
  const stateDir = await temp(t, 'ba56-state-');
  const calls = [];
  const result = await proposeCurrentState({
    vault,
    config: configOf(),
    stateDir,
    now: NOW,
    runCommand: faking(calls, openProposal()),
  });
  assert.equal(calls.length, 0);
  assert.deepEqual(result.skipped, [{ page: OPEN, reason: 'unsafe-input', ruleIds: ['anthropic'] }]);
  await assert.rejects(readFile(join(stateDir, 'synthesis', 'ledger.json')), (error) => error.code === 'ENOENT');
  assert.deepEqual(await recordFiles(stateDir), []);
  assert.equal(JSON.stringify(result).includes(SECRET), false);
});

test('a model answer with a secret is skipped as unsafe-output after the charged call', async (t) => {
  const vault = await vaultWith(t, [{ path: OPEN, title: 'Open', text: pageText('Open', '', openBody) }]);
  const stateDir = await temp(t, 'ba56-state-');
  const calls = [];
  const result = await proposeCurrentState({
    vault,
    config: configOf(),
    stateDir,
    now: NOW,
    runCommand: faking(calls, () => `The model leaked ${SECRET} instead of JSON.`),
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(result.skipped, [{ page: OPEN, reason: 'unsafe-output', ruleIds: ['anthropic'] }]);
  assert.deepEqual(result.proposals, []);
  assert.deepEqual(await recordFiles(stateDir), []);
  const ledger = JSON.parse(await readFile(join(stateDir, 'synthesis', 'ledger.json'), 'utf8'));
  assert.equal(ledger['2026-W47'].calls, 1);
  assert.equal(JSON.stringify(result).includes(SECRET), false);
});

test(
  'synthesis record files, the ledger and the proposals directory are private',
  { skip: process.platform === 'win32' },
  async (t) => {
    const vault = await vaultWith(t, [{ path: OPEN, title: 'Open', text: pageText('Open', '', openBody) }]);
    const stateDir = await temp(t, 'ba56-state-');
    const calls = [];
    const result = await proposeCurrentState({
      vault,
      config: configOf(),
      stateDir,
      now: NOW,
      runCommand: faking(calls, openProposal()),
    });
    assert.equal(result.proposals.length, 1);
    const directory = join(stateDir, 'synthesis', 'proposals');
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    const names = await recordFiles(stateDir);
    assert.equal(names.length, 1);
    assert.equal((await stat(join(directory, names[0]))).mode & 0o777, 0o600);
    assert.equal((await stat(join(stateDir, 'synthesis', 'ledger.json'))).mode & 0o777, 0o600);
  }
);

test('BRAINATLAS_OFFLINE skips the model before any read and the weekly run still finishes', async (t) => {
  const vault = await vaultWith(t, [{ path: OPEN, title: 'Open', text: pageText('Open', '', openBody) }]);
  const calls = [];
  const stateDir = await temp(t, 'ba56-state-');
  assert.deepEqual(
    await proposeCurrentState({
      vault,
      config: configOf(),
      stateDir,
      now: NOW,
      runCommand: faking(calls),
      env: cleanEnv({ BRAINATLAS_OFFLINE: '1' }),
    }),
    { ran: false, reason: 'offline' }
  );
  assert.equal(calls.length, 0);
  await assert.rejects(readFile(join(stateDir, 'synthesis', 'ledger.json')), (error) => error.code === 'ENOENT');

  const home = await temp(t, 'ba56-home-');
  const env = cleanEnv({
    HOME: home,
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_DATA_HOME: join(home, 'data'),
    XDG_STATE_HOME: join(home, 'state'),
    BRAINATLAS_PLATFORM: 'linux',
    BRAINATLAS_OFFLINE: '1',
    UID: '501',
  });
  const paths = resolvePaths({ platform: 'linux', env });
  let cfg = defaultConfig('lite');
  cfg.vault.path = vault;
  cfg = setConfigValue(cfg, 'maintain.synthesis.mode', 'shadow');
  cfg = setConfigValue(cfg, 'maintain.synthesis.command', ['fake-model']);
  await saveConfig(cfg, { paths });

  const lines = [];
  const original = console.log;
  console.log = (...values) => lines.push(values.join(' '));
  try {
    await main(['maintain', '--weekly', '--json'], env, { runCommand: faking(calls) });
  } finally {
    console.log = original;
  }
  const snapshot = JSON.parse(lines.join(''));
  assert.deepEqual(snapshot.synthesis, { ran: false, reason: 'offline' });
  assert.equal(calls.length, 0);
});

test('accept refuses a vault that is not the configured vault and never writes it', async (t) => {
  const configured = await vaultWith(t, [{ path: OPEN, title: 'Open', text: pageText('Open', '', openBody) }]);
  const other = await vaultWith(t, [{ path: OPEN, title: 'Open', text: pageText('Open', '', openBody) }]);
  const home = await temp(t, 'ba56-home-');
  const env = cleanEnv({
    HOME: home,
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_DATA_HOME: join(home, 'data'),
    XDG_STATE_HOME: join(home, 'state'),
    BRAINATLAS_PLATFORM: 'linux',
    BRAINATLAS_OFFLINE: '1',
    UID: '501',
  });
  const paths = resolvePaths({ platform: 'linux', env });
  const cfg = defaultConfig('lite');
  cfg.vault.path = configured;
  await saveConfig(cfg, { paths });

  const before = await readFile(join(other, OPEN), 'utf8');
  const expected = (error) =>
    error.code === 'E_NOT_CONFIGURED_VAULT' &&
    error.message === 'maintain --proposals accept only writes to the configured vault.';
  await assert.rejects(
    main(['maintain', '--proposals', 'accept', '20261118-abcdef12', '--vault', other, '--json'], env),
    expected
  );
  assert.equal(await readFile(join(other, OPEN), 'utf8'), before);

  // A missing config is refused the same way; list still works on a foreign vault.
  const bareHome = await temp(t, 'ba56-home-');
  const bareEnv = cleanEnv({
    HOME: bareHome,
    XDG_CONFIG_HOME: join(bareHome, 'config'),
    XDG_DATA_HOME: join(bareHome, 'data'),
    XDG_STATE_HOME: join(bareHome, 'state'),
    BRAINATLAS_PLATFORM: 'linux',
    BRAINATLAS_OFFLINE: '1',
    UID: '501',
  });
  await assert.rejects(
    main(['maintain', '--proposals', 'accept', '20261118-abcdef12', '--vault', other, '--json'], bareEnv),
    expected
  );
  const lines = [];
  const original = console.log;
  console.log = (...values) => lines.push(values.join(' '));
  try {
    await main(['maintain', '--proposals', 'list', '--vault', other, '--json'], env);
  } finally {
    console.log = original;
  }
  assert.equal(JSON.parse(lines.join('')).action, 'list');
  assert.equal(await readFile(join(other, OPEN), 'utf8'), before);
});
