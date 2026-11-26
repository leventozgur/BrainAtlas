// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { atomicWriteFile, resolvePaths, vaultId } from '../../packages/core/src/index.mjs';
import { main } from '../../packages/cli/src/index.mjs';
import { createStore } from '../../packages/cli/src/synthesis/core.mjs';
import {
  acceptProposal,
  listProposals,
  rejectProposal,
  showProposal,
} from '../../packages/cli/src/synthesis/review.mjs';
import { cleanEnv } from './clean-env.mjs';

const FIXTURES = resolve('tests/fixtures/ba48b');
const PAGE = 'wiki/concepts/atlas.md';
const NOW = new Date('2026-11-18T00:00:00.000Z');

async function temp(t, prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function fixture(t) {
  const root = await temp(t, 'ba48b-review-');
  const vault = join(root, 'vault');
  await cp(join(FIXTURES, 'vault'), vault, { recursive: true });
  const home = join(root, 'home');
  await mkdir(home, { recursive: true });
  const env = cleanEnv({
    HOME: home,
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_DATA_HOME: join(home, 'data'),
    XDG_STATE_HOME: join(home, 'state'),
    BRAINATLAS_PLATFORM: 'linux',
    BRAINATLAS_OFFLINE: '1',
  });
  const paths = resolvePaths({ platform: 'linux', env });
  return { root, vault, home, env, paths, stateDir: join(paths.stateDir, vaultId(resolve(vault))) };
}

const anchor = (quote) => ({ source: 'page', quote });
const sentence = (text) => ({ text, anchors: [anchor(text)] });
const proposalOf = (page = PAGE) => ({
  schemaVersion: 1,
  page,
  sentences: [sentence('The Atlas runtime listens on port 7070.'), sentence('The cache limit is 512 MB.')],
  conflicts: [],
});
const gateOk = () => ({
  ok: true,
  failures: [],
  delta: { droppedSentences: 0, changedNumbers: [], lostCaveats: 0, blockWords: 12 },
});

async function seed(options) {
  const {
    vault,
    stateDir,
    page = PAGE,
    createdAt = NOW.toISOString(),
    proposal = proposalOf(page),
    shadow = false,
  } = options;
  const text = await readFile(join(vault, page), 'utf8');
  const store = createStore(stateDir);
  return store.save({
    batch: '2026-W47',
    page,
    baseHash: createHash('sha256').update(text).digest('hex'),
    createdAt,
    proposal,
    gates: gateOk(),
    shadow,
  });
}

async function pageText(vault, page = PAGE) {
  return readFile(join(vault, page), 'utf8');
}

async function longPage(f) {
  const page = 'wiki/concepts/long.md';
  const body = [
    '---',
    'type: concept',
    'title: Long page',
    'status: confirmed',
    'verified: []',
    'sources: []',
    'stale_after: "2027-01-01"',
    'keywords: ["long page"]',
    '---',
    '# Long page',
    '',
    'The service is stable.',
    '',
    ...['2026-04-01', '2026-03-01', '2026-02-01', '2026-01-01'].flatMap((date) => [
      `## Update ${date}`,
      '',
      `A note for ${date}.`,
      '',
    ]),
  ].join('\n');
  await mkdir(join(f.vault, 'wiki', 'concepts'), { recursive: true });
  await writeFile(join(f.vault, page), body);
  return {
    page,
    archive: 'wiki/archive/concepts--long-history.md',
    proposal: { schemaVersion: 1, page, sentences: [sentence('The service is stable.')], conflicts: [] },
  };
}

test('list shows open records newest first without page text', async (t) => {
  const f = await fixture(t);
  const older = await seed({
    ...f,
    page: 'wiki/concepts/atlas-copy.md',
    proposal: proposalOf('wiki/concepts/atlas-copy.md'),
    createdAt: '2026-11-12T00:00:00.000Z',
  });
  const newer = await seed({ ...f, createdAt: '2026-11-17T00:00:00.000Z', shadow: true });
  const expired = await seed({
    ...f,
    page: 'wiki/concepts/atlas-copy.md',
    proposal: proposalOf('wiki/concepts/atlas-copy.md'),
    createdAt: '2026-10-01T00:00:00.000Z',
  });

  const result = await listProposals({ stateDir: f.stateDir, now: NOW });
  assert.equal(result.action, 'list');
  assert.deepEqual(
    result.proposals.map((item) => item.id),
    [newer.id, older.id]
  );
  assert.equal(result.proposals[0].shadow, true);
  assert.equal(result.proposals[0].gateStatus, 'passed');
  assert.equal('gates' in result.proposals[0], false);
  assert.equal('gate' in result.proposals[0], false);
  assert.equal(JSON.stringify(result).includes('The Atlas runtime listens'), false);
  assert.equal((await createStore(f.stateDir).get(expired.id)).status, 'expired');
});

test('show prints the delta first, the rendered block and a unified diff', async (t) => {
  const f = await fixture(t);
  const saved = await seed(f);
  const result = await showProposal({ ...f, id: saved.id, now: NOW });
  assert.equal(result.status, 'open');
  assert.deepEqual(result.delta, {
    droppedSentences: 0,
    changedNumbers: [],
    lostCaveats: 0,
    blockWords: 12,
    conflicts: 0,
  });
  assert.ok(result.block.startsWith('## Current state (proposed 2026-11-18)'));
  assert.ok(result.diff.startsWith(`--- a/${PAGE}`));
  assert.ok(result.diff.includes('+<!-- brainatlas:current-state -->'));
  assert.equal(Object.keys(result)[Object.keys(result).indexOf('delta') + 1], 'block');
});

test('show marks a changed page invalidated with reason page-changed', async (t) => {
  const f = await fixture(t);
  const saved = await seed(f);
  await writeFile(join(f.vault, PAGE), `${await pageText(f.vault)}\nAn outside edit.\n`);
  const result = await showProposal({ ...f, id: saved.id, now: NOW });
  assert.equal(result.status, 'invalidated');
  assert.equal(result.reason, 'page-changed');
  assert.equal((await createStore(f.stateDir).get(saved.id)).status, 'invalidated');
});

test('reject changes only the stored status', async (t) => {
  const f = await fixture(t);
  const saved = await seed(f, { shadow: true });
  const before = await pageText(f.vault);
  const result = await rejectProposal({ ...f, id: saved.id });
  assert.equal(result.status, 'rejected');
  assert.equal((await createStore(f.stateDir).get(saved.id)).status, 'rejected');
  assert.equal(await pageText(f.vault), before);
});

test('accept writes the block, the compacted archive and one content-free log entry', async (t) => {
  const f = await fixture(t);
  const page = 'wiki/concepts/long.md';
  const body = [
    '---',
    'type: concept',
    'title: Long page',
    'status: confirmed',
    'verified: []',
    'sources: []',
    'stale_after: "2027-01-01"',
    'keywords: ["long page"]',
    '---',
    '# Long page',
    '',
    'The service is stable.',
    '',
    ...['2026-04-01', '2026-03-01', '2026-02-01', '2026-01-01'].flatMap((date) => [
      `## Update ${date}`,
      '',
      `A note for ${date}.`,
      '',
    ]),
  ].join('\n');
  await mkdir(join(f.vault, 'wiki', 'concepts'), { recursive: true });
  await writeFile(join(f.vault, page), body);
  const proposal = { schemaVersion: 1, page, sentences: [sentence('The service is stable.')], conflicts: [] };
  const saved = await seed({ ...f, page, proposal });

  const result = await acceptProposal({ ...f, id: saved.id, now: NOW });
  assert.equal(result.status, 'accepted');
  assert.equal(result.gateStatus, 'passed');
  assert.equal('gates' in result, false);
  assert.equal((await createStore(f.stateDir).get(saved.id)).status, 'accepted');
  const written = await pageText(f.vault, page);
  assert.ok(written.includes('<!-- brainatlas:current-state -->'));
  assert.equal(written.includes('A note for 2026-01-01.'), false);
  const archive = await readFile(join(f.vault, 'wiki', 'archive', 'concepts--long-history.md'), 'utf8');
  assert.ok(archive.includes('A note for 2026-01-01.'));
  const log = await readFile(join(f.vault, 'wiki', 'log.md'), 'utf8');
  assert.ok(log.includes('"action":"synthesis-accept"'));
  assert.ok(log.includes(`"path":"${page}"`));
  assert.equal(result.retrieval.before.length, 2);
  assert.equal('retrievalBefore' in result, false);
  assert.equal('retrievalAfter' in result, false);
});

test('accept refuses shadow, expired, stale, non-open and conflicted-copy records', async (t) => {
  const f = await fixture(t);
  const shadow = await seed({ ...f, shadow: true });
  await assert.rejects(
    acceptProposal({ ...f, id: shadow.id, now: NOW }),
    (error) => error.code === 'E_PROPOSAL_SHADOW'
  );
  assert.equal(await pageText(f.vault), await pageText(join(FIXTURES, 'vault')));

  const expired = await seed({ ...f, createdAt: '2026-10-01T00:00:00.000Z' });
  await assert.rejects(
    acceptProposal({ ...f, id: expired.id, now: NOW }),
    (error) => error.code === 'E_PROPOSAL_EXPIRED'
  );
  assert.equal((await createStore(f.stateDir).get(expired.id)).status, 'expired');

  const stale = await seed({ ...f, createdAt: '2026-11-17T00:00:00.000Z' });
  await writeFile(join(f.vault, PAGE), `${await pageText(f.vault)}\noutside\n`);
  await assert.rejects(acceptProposal({ ...f, id: stale.id, now: NOW }), (error) => error.code === 'E_PROPOSAL_STALE');
  assert.equal((await createStore(f.stateDir).get(stale.id)).status, 'invalidated');

  const fresh = await fixture(t);
  const rejected = await seed(fresh);
  await rejectProposal({ ...fresh, id: rejected.id });
  await assert.rejects(
    acceptProposal({ ...fresh, id: rejected.id, now: NOW }),
    (error) => error.code === 'E_PROPOSAL_STATE'
  );

  const conflicted = await seed({ ...fresh, createdAt: '2026-11-17T00:00:00.000Z' });
  await writeFile(join(fresh.vault, 'wiki', 'concepts', 'notes (conflicted copy 2026-11-18).md'), '# note\n');
  const before = await pageText(fresh.vault);
  await assert.rejects(
    acceptProposal({ ...fresh, id: conflicted.id, now: NOW }),
    (error) => error.code === 'E_CONFLICTED_COPY'
  );
  assert.equal(await pageText(fresh.vault), before);
});

test('accept re-runs the gates and writes nothing when they fail', async (t) => {
  const f = await fixture(t);
  const proposal = {
    schemaVersion: 1,
    page: PAGE,
    sentences: [{ text: 'An invented fact.', anchors: [anchor('This quote is not in the page.')] }],
    conflicts: [],
  };
  const saved = await seed({ ...f, proposal });
  const before = await pageText(f.vault);
  await assert.rejects(acceptProposal({ ...f, id: saved.id, now: NOW }), (error) => error.code === 'E_GATE_FAILED');
  assert.equal(await pageText(f.vault), before);
  assert.equal((await createStore(f.stateDir).get(saved.id)).status, 'open');
});

test('show reports page-changed only for an open record invalidated by that call', async (t) => {
  const f = await fixture(t);
  const saved = await seed(f);
  await writeFile(join(f.vault, PAGE), `${await pageText(f.vault)}\noutside\n`);
  const first = await showProposal({ ...f, id: saved.id, now: NOW });
  assert.equal(first.status, 'invalidated');
  assert.equal(first.reason, 'page-changed');
  const second = await showProposal({ ...f, id: saved.id, now: NOW });
  assert.equal(second.status, 'invalidated');
  assert.equal('reason' in second, false);
});

test('a page write failure restores both originals and rethrows the write error', async (t) => {
  const f = await fixture(t);
  const lp = await longPage(f);
  const saved = await seed({ ...f, page: lp.page, proposal: lp.proposal });
  const pageBefore = await readFile(join(f.vault, lp.page));
  let calls = 0;
  const dependencies = {
    atomicWriteFile: async (file, data, ...rest) => {
      calls++;
      if (calls === 2) throw new Error('page-write-failed');
      return atomicWriteFile(file, data, ...rest);
    },
  };
  await assert.rejects(
    acceptProposal({ ...f, id: saved.id, now: NOW, dependencies }),
    (error) => error.message === 'page-write-failed'
  );
  assert.deepEqual(await readFile(join(f.vault, lp.page)), pageBefore);
  await assert.rejects(readFile(join(f.vault, lp.archive)), (error) => error.code === 'ENOENT');
  assert.equal((await createStore(f.stateDir).get(saved.id)).status, 'reverted');
});

test('an appendLog failure restores both originals and rethrows the log error', async (t) => {
  const f = await fixture(t);
  const lp = await longPage(f);
  const saved = await seed({ ...f, page: lp.page, proposal: lp.proposal });
  const pageBefore = await readFile(join(f.vault, lp.page));
  const dependencies = {
    appendLog: async () => {
      throw new Error('log-write-failed');
    },
  };
  await assert.rejects(
    acceptProposal({ ...f, id: saved.id, now: NOW, dependencies }),
    (error) => error.message === 'log-write-failed'
  );
  assert.deepEqual(await readFile(join(f.vault, lp.page)), pageBefore);
  await assert.rejects(readFile(join(f.vault, lp.archive)), (error) => error.code === 'ENOENT');
  assert.equal((await createStore(f.stateDir).get(saved.id)).status, 'reverted');
  const log = await readFile(join(f.vault, 'wiki', 'log.md'), 'utf8').catch(() => '');
  assert.equal(log.includes('synthesis-accept'), false);
});

test('a post-write OKF check failure restores both originals and rethrows the check error', async (t) => {
  const f = await fixture(t);
  const lp = await longPage(f);
  const saved = await seed({ ...f, page: lp.page, proposal: lp.proposal });
  const pageBefore = await readFile(join(f.vault, lp.page));
  let calls = 0;
  const dependencies = {
    okfErrors: () => {
      calls++;
      if (calls === 2) throw new Error('okf-check-failed');
      return new Set();
    },
  };
  await assert.rejects(
    acceptProposal({ ...f, id: saved.id, now: NOW, dependencies }),
    (error) => error.message === 'okf-check-failed'
  );
  assert.deepEqual(await readFile(join(f.vault, lp.page)), pageBefore);
  await assert.rejects(readFile(join(f.vault, lp.archive)), (error) => error.code === 'ENOENT');
  assert.equal((await createStore(f.stateDir).get(saved.id)).status, 'reverted');
});

test('a failing lint baseline refuses with E_APPLY_CHECK and writes nothing', async (t) => {
  const f = await fixture(t);
  const lp = await longPage(f);
  const saved = await seed({ ...f, page: lp.page, proposal: lp.proposal });
  const pageBefore = await readFile(join(f.vault, lp.page));
  const dependencies = {
    lintFindings: async () => {
      throw new Error('lint-baseline-failed');
    },
  };
  await assert.rejects(
    acceptProposal({ ...f, id: saved.id, now: NOW, dependencies }),
    (error) => error.code === 'E_APPLY_CHECK'
  );
  assert.deepEqual(await readFile(join(f.vault, lp.page)), pageBefore);
  assert.equal((await createStore(f.stateDir).get(saved.id)).status, 'open');
});

test('a post-write lint failure is a reverted E_APPLY_REGRESSION with check name lint', async (t) => {
  const f = await fixture(t);
  const lp = await longPage(f);
  const saved = await seed({ ...f, page: lp.page, proposal: lp.proposal });
  const pageBefore = await readFile(join(f.vault, lp.page));
  let calls = 0;
  const dependencies = {
    lintFindings: async () => {
      calls++;
      if (calls === 1) return new Set();
      throw new Error('lint-post-failed');
    },
  };
  await assert.rejects(
    acceptProposal({ ...f, id: saved.id, now: NOW, dependencies }),
    (error) => error.code === 'E_APPLY_REGRESSION' && error.checks.includes('lint')
  );
  assert.deepEqual(await readFile(join(f.vault, lp.page)), pageBefore);
  await assert.rejects(readFile(join(f.vault, lp.archive)), (error) => error.code === 'ENOENT');
  assert.equal((await createStore(f.stateDir).get(saved.id)).status, 'reverted');
});

test('a planCompaction error refuses the apply before any write', async (t) => {
  const f = await fixture(t);
  const lp = await longPage(f);
  const saved = await seed({ ...f, page: lp.page, proposal: lp.proposal });
  const pageBefore = await readFile(join(f.vault, lp.page));
  const dependencies = {
    planCompaction: async () => {
      throw Object.assign(new Error('plan-failed'), { code: 'E_PLAN_FAILED' });
    },
  };
  await assert.rejects(
    acceptProposal({ ...f, id: saved.id, now: NOW, dependencies }),
    (error) => error.code === 'E_PLAN_FAILED'
  );
  assert.deepEqual(await readFile(join(f.vault, lp.page)), pageBefore);
  assert.equal((await createStore(f.stateDir).get(saved.id)).status, 'open');
});

test('a failed restore reports E_APPLY_RESTORE_FAILED with file names only', async (t) => {
  const f = await fixture(t);
  const lp = await longPage(f);
  const saved = await seed({ ...f, page: lp.page, proposal: lp.proposal });
  let calls = 0;
  const dependencies = {
    atomicWriteFile: async (file, data, ...rest) => {
      calls++;
      if (calls === 2 || (calls >= 3 && Buffer.isBuffer(data))) throw new Error('write-failed');
      return atomicWriteFile(file, data, ...rest);
    },
  };
  await assert.rejects(
    acceptProposal({ ...f, id: saved.id, now: NOW, dependencies }),
    (error) =>
      error.code === 'E_APPLY_RESTORE_FAILED' && error.message.includes('long.md') && !error.message.includes(f.vault)
  );
});

test('maintain --proposals without an action is E_ARGUMENT and never falls through', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    main(['maintain', '--proposals', '--json', '--vault', f.vault], f.env),
    (error) => error.code === 'E_ARGUMENT'
  );
});

test('maintain --proposals list --json reads the vault state directory', async (t) => {
  const f = await fixture(t);
  const saved = await seed({ ...f, createdAt: new Date().toISOString() });
  const lines = [];
  const original = console.log;
  console.log = (...values) => lines.push(values.join(' '));
  try {
    await main(['maintain', '--proposals', 'list', '--vault', f.vault, '--json'], f.env);
  } finally {
    console.log = original;
  }
  const result = JSON.parse(lines.join(''));
  assert.equal(result.action, 'list');
  assert.deepEqual(
    result.proposals.map((item) => item.id),
    [saved.id]
  );
});
