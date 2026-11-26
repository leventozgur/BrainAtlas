// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  defaultConfig,
  resolvePaths,
  saveConfig,
  setConfigValue,
  validateConfig,
  vaultId,
} from '../../packages/core/src/index.mjs';
import { main } from '../../packages/cli/src/index.mjs';
import { createStore } from '../../packages/cli/src/synthesis/core.mjs';
import { proposeCurrentState, synthesisSettings } from '../../packages/cli/src/synthesis/propose.mjs';
import { runWeeklyMaintenance } from '../../packages/cli/src/maintain-weekly.mjs';
import { cleanEnv } from './clean-env.mjs';

const FIXTURES = resolve('tests/fixtures/ba48b');
const OLD = new Date('2026-10-01T00:00:00.000Z');
const NOW = new Date('2026-11-18T00:00:00.000Z');
const PAGE = 'wiki/concepts/atlas.md';

async function temp(t, prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function oldVault(t) {
  const root = await temp(t, 'ba48b-propose-vault-');
  const vault = join(root, 'vault');
  await cp(join(FIXTURES, 'vault'), vault, { recursive: true });
  for (const rel of [
    'wiki/concepts/atlas.md',
    'wiki/concepts/atlas-copy.md',
    'wiki/archive/atlas-history.md',
    'wiki/index.md',
    'wiki/log.md',
  ]) {
    await utimes(join(vault, rel), OLD, OLD).catch(() => {});
  }
  return { root, vault };
}

const proposalOf = (page = PAGE) => ({
  schemaVersion: 1,
  page,
  sentences: [
    {
      text: 'The Atlas runtime listens on port 7070.',
      anchors: [{ source: 'page', quote: 'The Atlas runtime listens on port 7070.' }],
    },
    { text: 'The cache limit is 512 MB.', anchors: [{ source: 'page', quote: 'The cache limit is 512 MB.' }] },
  ],
  conflicts: [],
});

const configOf = (synthesis) => ({ maintain: { synthesis } });

function faking(calls, stdout = proposalOf()) {
  return async (command, args, options) => {
    calls.push({ command, args, input: options.input, timeoutMs: options.timeoutMs });
    return {
      code: 0,
      stdout: typeof stdout === 'function' ? stdout(calls.length) : JSON.stringify(stdout),
      stderr: '',
    };
  };
}

async function tree(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const child = join(dir, entry.name);
    if (entry.isDirectory()) out.push(`d ${entry.name}`, ...(await tree(child)).map((line) => `${entry.name}/${line}`));
    else
      out.push(
        `f ${entry.name} ${createHash('sha256')
          .update(await readFile(child))
          .digest('hex')}`
      );
  }
  return out.sort();
}

test('the config schema accepts maintain.synthesis with defaults and rejects invalid values', () => {
  const base = defaultConfig('lite');
  assert.equal('maintain' in base, false);
  assert.deepEqual(validateConfig(base), { ok: true, errors: [] });

  let cfg = setConfigValue(base, 'maintain.synthesis.mode', 'shadow');
  cfg = setConfigValue(cfg, 'maintain.synthesis.command', ['opencode', 'run', '-m', 'opencode-go/deepseek-v4.1-flash']);
  cfg = setConfigValue(cfg, 'maintain.synthesis.pagesPerWeek', 3);
  cfg = setConfigValue(cfg, 'maintain.synthesis.maxInputChars', 200000);
  cfg = setConfigValue(cfg, 'maintain.synthesis.maxCallsPerWeek', 10);
  cfg = setConfigValue(cfg, 'maintain.synthesis.maxUsdPerWeek', 20);
  cfg = setConfigValue(cfg, 'maintain.synthesis.usdPer1kTokens', 1);
  cfg = setConfigValue(cfg, 'maintain.synthesis.timeoutMs', 600000);
  assert.deepEqual(validateConfig(cfg), { ok: true, errors: [] });
  assert.equal(cfg.maintain.synthesis.mode, 'shadow');
  assert.deepEqual(cfg.maintain.synthesis.command, ['opencode', 'run', '-m', 'opencode-go/deepseek-v4.1-flash']);
  assert.deepEqual(validateConfig({ ...base, maintain: { synthesis: {} } }), { ok: true, errors: [] });

  for (const [key, value] of [
    ['maintain.synthesis.mode', 'always'],
    ['maintain.synthesis.pagesPerWeek', 4],
    ['maintain.synthesis.maxInputChars', 999],
    ['maintain.synthesis.maxCallsPerWeek', 11],
    ['maintain.synthesis.maxUsdPerWeek', 21],
    ['maintain.synthesis.usdPer1kTokens', 2],
    ['maintain.synthesis.timeoutMs', 9999],
  ]) {
    assert.throws(
      () => setConfigValue(base, key, value),
      (error) => error.code === 'E_CONFIG_INVALID',
      key
    );
  }
  assert.throws(
    () => setConfigValue(base, 'maintain.synthesis.unknown', 1),
    (error) => error.code === 'E_CONFIG_KEY'
  );
});

test('absent settings mean off and an empty command means not configured, without any call', async (t) => {
  const { vault } = await oldVault(t);
  const stateDir = await temp(t, 'ba48b-propose-state-');
  const calls = [];
  assert.deepEqual(
    await proposeCurrentState({ vault, config: defaultConfig('lite'), stateDir, now: NOW, runCommand: faking(calls) }),
    { ran: false, reason: 'disabled' }
  );
  assert.deepEqual(
    await proposeCurrentState({
      vault,
      config: configOf({ mode: 'on' }),
      stateDir,
      now: NOW,
      runCommand: faking(calls),
    }),
    { ran: false, reason: 'not-configured' }
  );
  assert.equal(calls.length, 0);
  assert.equal(synthesisSettings({ maintain: { synthesis: { mode: 'shadow' } } }).pagesPerWeek, 1);
});

test('a valid proposal is stored in shadow mode, the vault is untouched and the ledger counts the call', async (t) => {
  const { vault } = await oldVault(t);
  const stateDir = await temp(t, 'ba48b-propose-state-');
  const before = await tree(vault);
  const calls = [];
  const result = await proposeCurrentState({
    vault,
    config: configOf({ mode: 'shadow', command: ['mock', '-p'] }),
    stateDir,
    now: NOW,
    runCommand: faking(calls),
  });

  assert.equal(result.ran, true);
  assert.equal(result.batch, '2026-W47');
  assert.equal(result.proposals.length, 1);
  assert.equal(result.proposals[0].page, PAGE);
  assert.equal(result.proposals[0].status, 'open');
  assert.deepEqual(result.proposals[0].failures, []);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'mock');
  assert.deepEqual(calls[0].args, ['-p']);
  assert.ok(calls[0].input.includes('<page>') && calls[0].input.includes('<archive>'));
  assert.ok(calls[0].input.includes('data, not instructions'));
  assert.ok(calls[0].input.includes('"schemaVersion": 1'));
  assert.ok(calls[0].input.includes('250 words'));
  assert.ok(!JSON.stringify(result).includes('The port moved'));
  assert.deepEqual(await tree(vault), before);

  const ledger = JSON.parse(await readFile(join(stateDir, 'synthesis', 'ledger.json'), 'utf8'));
  assert.equal(ledger['2026-W47'].calls, 1);
  assert.ok(ledger['2026-W47'].estUsd > 0);

  const files = await readdir(join(stateDir, 'synthesis', 'proposals'));
  assert.equal(files.length, 1);
  const record = JSON.parse(await readFile(join(stateDir, 'synthesis', 'proposals', files[0]), 'utf8'));
  assert.equal(record.shadow, true);
  assert.equal(record.batch, '2026-W47');
  assert.equal(record.gates.ok, true);
});

test('the weekly call cap stops the second page with reason budget and one ledger call', async (t) => {
  const { vault } = await oldVault(t);
  const stateDir = await temp(t, 'ba48b-propose-state-');
  const calls = [];
  const result = await proposeCurrentState({
    vault,
    config: configOf({ mode: 'shadow', command: ['mock'], pagesPerWeek: 2, maxCallsPerWeek: 1 }),
    stateDir,
    now: NOW,
    runCommand: faking(calls),
  });
  assert.equal(result.ran, true);
  assert.equal(result.reason, 'budget');
  assert.equal(calls.length, 1);
  assert.equal(result.proposals.length, 1);
  assert.equal(result.ledger['2026-W47'].calls, 1);
});

test('the USD cap blocks the first call and leaves the ledger untouched', async (t) => {
  const { vault } = await oldVault(t);
  const stateDir = await temp(t, 'ba48b-propose-state-');
  const calls = [];
  const result = await proposeCurrentState({
    vault,
    config: configOf({ mode: 'shadow', command: ['mock'], maxUsdPerWeek: 0 }),
    stateDir,
    now: NOW,
    runCommand: faking(calls),
  });
  assert.deepEqual(result, { ran: true, batch: '2026-W47', proposals: [], ledger: {}, reason: 'budget' });
  assert.equal(calls.length, 0);
});

test('invalid JSON and a schema violation are rejected without a retry', async (t) => {
  const { vault } = await oldVault(t);
  for (const stdout of ['no json at all', '{"schemaVersion":2,"page":"wiki/concepts/atlas.md","sentences":[]}']) {
    const stateDir = await temp(t, 'ba48b-propose-state-');
    const calls = [];
    const result = await proposeCurrentState({
      vault,
      config: configOf({ mode: 'shadow', command: ['mock'] }),
      stateDir,
      now: NOW,
      runCommand: faking(calls, () => stdout),
    });
    assert.equal(calls.length, 1);
    assert.equal(result.proposals.length, 1);
    assert.equal(result.proposals[0].status, 'rejected-schema');
    assert.equal(result.proposals[0].failures[0].gate, 'SCHEMA');
    const files = await readdir(join(stateDir, 'synthesis', 'proposals'));
    const record = JSON.parse(await readFile(join(stateDir, 'synthesis', 'proposals', files[0]), 'utf8'));
    assert.equal(record.status, 'rejected-schema');
  }
});

test('a transport failure is retried once with the same command, and the output envelope is unwrapped', async (t) => {
  const { vault } = await oldVault(t);
  const stateDir = await temp(t, 'ba48b-propose-state-');
  const calls = [];
  const runCommand = async (command, args) => {
    calls.push([command, ...args].join(' '));
    if (calls.length === 1) throw new Error('spawn failed');
    return { code: 0, stdout: JSON.stringify({ type: 'result', result: JSON.stringify(proposalOf()) }), stderr: '' };
  };
  const result = await proposeCurrentState({
    vault,
    config: configOf({ mode: 'shadow', command: ['mock'] }),
    stateDir,
    now: NOW,
    runCommand,
  });
  assert.deepEqual(calls, ['mock', 'mock']);
  assert.equal(result.proposals[0].status, 'open');
  assert.equal(result.ledger['2026-W47'].calls, 2);

  const failingCalls = [];
  const failing = await proposeCurrentState({
    vault,
    config: configOf({ mode: 'shadow', command: ['mock'] }),
    stateDir: await temp(t, 'ba48b-propose-state-'),
    now: NOW,
    runCommand: async (command, args) => {
      failingCalls.push(1);
      return { code: 1, stdout: '', stderr: 'boom' };
    },
  });
  assert.equal(failingCalls.length, 2);
  assert.deepEqual(failing.proposals, []);
  assert.deepEqual(failing.skipped, [{ page: PAGE, reason: 'transport-failure' }]);
});

test('a page larger than maxInputChars is skipped as too-large before any call', async (t) => {
  const root = await temp(t, 'ba48b-propose-vault-');
  const vault = join(root, 'vault');
  const words = Array.from({ length: 400 }, () => 'word').join(' ');
  await mkdir(join(vault, 'wiki'), { recursive: true });
  await writeFile(
    join(vault, 'wiki', 'big.md'),
    `---\ntype: concept\ntitle: Big\nstatus: confirmed\nverified: []\nsources: []\nstale_after: 2020-01-01\n---\n# Big\n\n${words}\n`
  );
  await writeFile(join(vault, 'wiki', 'index.md'), '# Wiki Index\n\n- [Big](big.md)\n');
  await utimes(join(vault, 'wiki', 'big.md'), OLD, OLD);
  await utimes(join(vault, 'wiki', 'index.md'), OLD, OLD);
  const calls = [];
  const result = await proposeCurrentState({
    vault,
    config: configOf({ mode: 'shadow', command: ['mock'], maxInputChars: 1000 }),
    stateDir: await temp(t, 'ba48b-propose-state-'),
    now: NOW,
    runCommand: faking(calls),
  });
  assert.equal(calls.length, 0);
  assert.deepEqual(result.proposals, []);
  assert.deepEqual(result.skipped, [{ page: 'wiki/big.md', reason: 'too-large' }]);
});

test('two unreviewed batches pause the model step as review-backlog', async (t) => {
  const { vault } = await oldVault(t);
  const stateDir = await temp(t, 'ba48b-propose-state-');
  const store = createStore(stateDir);
  const record = (page, batch) => ({
    batch,
    page,
    baseHash: batch,
    createdAt: NOW.toISOString(),
    proposal: proposalOf(page),
    gates: {
      ok: true,
      failures: [],
      delta: { droppedSentences: 0, changedNumbers: [], lostCaveats: 0, blockWords: 2 },
    },
  });
  await store.save(record('wiki/one.md', '2026-W45'));
  await store.save(record('wiki/two.md', '2026-W46'));
  const calls = [];
  assert.deepEqual(
    await proposeCurrentState({
      vault,
      config: configOf({ mode: 'shadow', command: ['mock'] }),
      stateDir,
      now: NOW,
      runCommand: faking(calls),
    }),
    { ran: false, reason: 'review-backlog' }
  );
  assert.equal(calls.length, 0);
});

test('the weekly run adds the synthesis result and one queue candidate', async (t) => {
  const { root, vault } = await oldVault(t);
  const stateDir = join(root, 'state');
  const candidates = [];
  const queue = async (list) => {
    candidates.push(...list);
    return { queued: true, candidates: list.length };
  };
  const calls = [];
  const { snapshot } = await runWeeklyMaintenance(vault, {
    paths: { stateDir },
    env: {},
    queue,
    now: NOW,
    config: configOf({ mode: 'shadow', command: ['mock'] }),
    runCommand: faking(calls),
  });
  assert.equal(snapshot.synthesis.ran, true);
  assert.equal(snapshot.synthesis.proposals.length, 1);
  assert.equal(calls.length, 1);
  const candidate = candidates.find((item) => item.title.startsWith('Current-state proposals:'));
  assert.equal(candidate.title, 'Current-state proposals: 1 page(s)');
  assert.deepEqual(candidate.sources, [PAGE]);
  const files = await readdir(join(stateDir, vaultId(resolve(vault)), 'synthesis', 'proposals'));
  assert.equal(files.length, 1);
});

test('a synthesis error is recorded in the snapshot and never fails the weekly run', async (t) => {
  const { root, vault } = await oldVault(t);
  const stateDir = join(root, 'state');
  const proposals = join(stateDir, vaultId(resolve(vault)), 'synthesis', 'proposals');
  await mkdir(proposals, { recursive: true });
  await writeFile(join(proposals, 'broken.json'), '{"id":"broken"}\n');
  const { snapshot } = await runWeeklyMaintenance(vault, {
    paths: { stateDir },
    env: {},
    queue: null,
    now: NOW,
    config: configOf({ mode: 'shadow', command: ['mock'] }),
  });
  assert.deepEqual(snapshot.synthesis, { ran: false, reason: 'error', code: 'E_STORE_CORRUPT' });
  assert.equal(snapshot.queue.reason, 'not-configured-vault');
  assert.ok(snapshot.pages > 0);
});

test('the weekly run with synthesis off keeps the snapshot shape unchanged', async (t) => {
  const { root, vault } = await oldVault(t);
  const { snapshot } = await runWeeklyMaintenance(vault, {
    paths: { stateDir: join(root, 'state') },
    env: {},
    queue: null,
    now: NOW,
  });
  assert.deepEqual(Object.keys(snapshot).sort(), ['compact', 'counts', 'fix', 'pages', 'queue', 'ranAt']);
});

const gateFailing = () => ({
  schemaVersion: 1,
  page: PAGE,
  sentences: [{ text: 'A missing fact.', anchors: [{ source: 'page', quote: 'This quote is not in the page.' }] }],
  conflicts: [],
});

test('only open proposals reach the queue candidate', async (t) => {
  const { root, vault } = await oldVault(t);
  const collect = async (stateName, stdout) => {
    const candidates = [];
    const calls = [];
    const { snapshot } = await runWeeklyMaintenance(vault, {
      paths: { stateDir: join(root, stateName) },
      env: {},
      now: NOW,
      queue: async (list) => {
        candidates.push(...list);
        return { queued: true, candidates: list.length };
      },
      config: configOf({ mode: 'shadow', command: ['mock'] }),
      runCommand: faking(calls, stdout),
    });
    return { snapshot, candidates };
  };

  const rejected = await collect('state-rejected', () => '{}');
  assert.equal(rejected.snapshot.synthesis.proposals[0].status, 'rejected-schema');
  assert.equal(
    rejected.candidates.some((item) => item.title.startsWith('Current-state proposals:')),
    false
  );

  const failed = await collect('state-gate-failed', gateFailing());
  assert.equal(failed.snapshot.synthesis.proposals[0].status, 'gate-failed');
  assert.equal(
    failed.candidates.some((item) => item.title.startsWith('Current-state proposals:')),
    false
  );

  const open = await collect('state-open', proposalOf());
  assert.equal(open.snapshot.synthesis.proposals[0].status, 'open');
  const candidate = open.candidates.find((item) => item.title.startsWith('Current-state proposals:'));
  assert.equal(candidate.title, 'Current-state proposals: 1 page(s)');
  assert.deepEqual(candidate.sources, [PAGE]);
});

test('a corrupt ledger stops the step with E_LEDGER_CORRUPT and is never overwritten', async (t) => {
  const { root, vault } = await oldVault(t);
  const stateDir = join(root, 'ledger-state');
  const ledgerFile = join(stateDir, 'synthesis', 'ledger.json');
  await mkdir(join(stateDir, 'synthesis'), { recursive: true });
  const contents = [
    'not json',
    '[]',
    '{"2026-W47": null}',
    '{"2026-W47": "x"}',
    '{"2026-W47": {"calls": "3", "estUsd": 0}}',
  ];
  for (const content of contents) {
    await writeFile(ledgerFile, content);
    const calls = [];
    await assert.rejects(
      proposeCurrentState({
        vault,
        config: configOf({ mode: 'shadow', command: ['mock'] }),
        stateDir,
        now: NOW,
        runCommand: faking(calls),
      }),
      (error) => error.code === 'E_LEDGER_CORRUPT',
      content
    );
    assert.equal(calls.length, 0);
    assert.equal(await readFile(ledgerFile, 'utf8'), content);
  }

  const weeklyState = join(root, 'weekly-ledger');
  const weeklyLedger = join(weeklyState, vaultId(resolve(vault)), 'synthesis', 'ledger.json');
  await mkdir(join(weeklyState, vaultId(resolve(vault)), 'synthesis'), { recursive: true });
  await writeFile(weeklyLedger, '{"2026-W47": null}');
  const calls = [];
  const { snapshot } = await runWeeklyMaintenance(vault, {
    paths: { stateDir: weeklyState },
    env: {},
    queue: null,
    now: NOW,
    config: configOf({ mode: 'shadow', command: ['mock'] }),
    runCommand: faking(calls),
  });
  assert.deepEqual(snapshot.synthesis, { ran: false, reason: 'error', code: 'E_LEDGER_CORRUPT' });
  assert.equal(calls.length, 0);
  assert.equal(await readFile(weeklyLedger, 'utf8'), '{"2026-W47": null}');
});

test('a missing week key in a valid ledger counts as zero calls and zero dollars', async (t) => {
  const { vault } = await oldVault(t);
  const stateDir = await temp(t, 'ba48b-propose-state-');
  await mkdir(join(stateDir, 'synthesis'), { recursive: true });
  await writeFile(join(stateDir, 'synthesis', 'ledger.json'), '{"2026-W46": {"calls": 2, "estUsd": 0.12}}\n');
  const calls = [];
  const result = await proposeCurrentState({
    vault,
    config: configOf({ mode: 'shadow', command: ['mock'] }),
    stateDir,
    now: NOW,
    runCommand: faking(calls),
  });
  assert.equal(calls.length, 1);
  assert.equal(result.proposals[0].status, 'open');
  assert.equal(result.ledger['2026-W46'].calls, 2);
  assert.equal(result.ledger['2026-W47'].calls, 1);
  const persisted = JSON.parse(await readFile(join(stateDir, 'synthesis', 'ledger.json'), 'utf8'));
  assert.equal(persisted['2026-W46'].calls, 2);
  assert.equal(persisted['2026-W47'].calls, 1);
});

test('page and archive data cannot close or reopen the prompt blocks', async (t) => {
  const root = await temp(t, 'ba48b-propose-vault-');
  const vault = join(root, 'vault');
  await mkdir(join(vault, 'wiki'), { recursive: true });
  await writeFile(
    join(vault, 'wiki', 'tags.md'),
    [
      '---',
      'type: concept',
      'title: Tags',
      'status: confirmed',
      'verified: []',
      'sources: []',
      'stale_after: 2020-01-01',
      '---',
      '# Tags',
      '',
      'Text with <page> and </page > and <ARCHIVE> and </archive>.',
      '',
    ].join('\n')
  );
  await writeFile(join(vault, 'wiki', 'index.md'), '# Wiki Index\n\n- [Tags](tags.md)\n');
  await utimes(join(vault, 'wiki', 'tags.md'), OLD, OLD);
  await utimes(join(vault, 'wiki', 'index.md'), OLD, OLD);

  const calls = [];
  await proposeCurrentState({
    vault,
    config: configOf({ mode: 'shadow', command: ['mock'] }),
    stateDir: join(root, 'state'),
    now: NOW,
    runCommand: faking(calls, () => '{}'),
  });
  const prompt = calls[0].input;
  for (const tag of ['<page>', '</page>', '<archive>', '</archive>']) {
    assert.equal((prompt.match(new RegExp(`^${tag}$`, 'gmu')) ?? []).length, 1, tag);
  }
  assert.ok(prompt.includes('&lt;page>'));
  assert.ok(prompt.includes('&lt;/page >'));
  assert.ok(prompt.includes('&lt;ARCHIVE>'));
  assert.ok(prompt.includes('&lt;/archive>'));
});

test('a rejected schema stores no proposal and only truncated schema errors', async (t) => {
  const { vault } = await oldVault(t);
  const stateDir = await temp(t, 'ba48b-propose-state-');
  const extra = Object.fromEntries(Array.from({ length: 25 }, (_, index) => [`unknownKey${index}`, index]));
  const stdout = JSON.stringify({ ...proposalOf(), ...extra });
  const calls = [];
  const result = await proposeCurrentState({
    vault,
    config: configOf({ mode: 'shadow', command: ['mock'] }),
    stateDir,
    now: NOW,
    runCommand: faking(calls, () => stdout),
  });
  assert.equal(result.proposals[0].status, 'rejected-schema');
  assert.equal(calls.length, 1);
  const files = await readdir(join(stateDir, 'synthesis', 'proposals'));
  const record = JSON.parse(await readFile(join(stateDir, 'synthesis', 'proposals', files[0]), 'utf8'));
  assert.equal(record.proposal, null);
  assert.equal(record.gates.failures.length, 1);
  const details = record.gates.failures[0].detail.split('; ');
  assert.equal(details.length, 20);
  assert.ok(details.every((detail) => detail.length <= 200));
  assert.ok(!JSON.stringify(record.gates).includes('The cache limit is 512 MB'));
});

test('--vault outside the configured vault records not-configured-vault and calls no model', async (t) => {
  const home = await temp(t, 'ba48b-home-');
  const env = cleanEnv({
    HOME: home,
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_DATA_HOME: join(home, 'data'),
    XDG_STATE_HOME: join(home, 'state'),
    BRAINATLAS_PLATFORM: 'linux',
    UID: '501',
  });
  const configured = join(home, 'vault-a');
  const other = join(home, 'vault-b');
  await cp(join(FIXTURES, 'vault'), configured, { recursive: true });
  await cp(join(FIXTURES, 'vault'), other, { recursive: true });
  const paths = resolvePaths({ platform: 'linux', env });
  let cfg = defaultConfig('lite');
  cfg.vault.path = configured;
  cfg = setConfigValue(cfg, 'maintain.synthesis.mode', 'shadow');
  cfg = setConfigValue(cfg, 'maintain.synthesis.command', ['mock']);
  await saveConfig(cfg, { paths });

  const calls = [];
  const lines = [];
  const original = console.log;
  console.log = (...values) => lines.push(values.join(' '));
  try {
    await main(['maintain', '--weekly', '--vault', other, '--json'], env, { runCommand: faking(calls) });
  } finally {
    console.log = original;
  }
  const snapshot = JSON.parse(lines.join(''));
  assert.deepEqual(snapshot.synthesis, { ran: false, reason: 'not-configured-vault' });
  assert.equal(calls.length, 0);
});
