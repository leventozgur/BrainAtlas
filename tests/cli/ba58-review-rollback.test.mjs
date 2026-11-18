// SPDX-License-Identifier: MIT
// BA-58: accept refuses to keep a page when the written bytes differ, or when the retrieval check regresses.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  DEFAULT_EXCLUDE_WIKI,
  atomicWriteFile,
  buildIndex,
  loadPagesDetailed,
  resolvePaths,
  vaultId,
} from '../../packages/core/src/index.mjs';
import { createStore } from '../../packages/cli/src/synthesis/core.mjs';
import { acceptProposal } from '../../packages/cli/src/synthesis/review.mjs';
import { cleanEnv } from './clean-env.mjs';

const FIXTURES = resolve('tests/fixtures/ba48b');
const NOW = new Date('2026-11-18T00:00:00.000Z');

async function temp(t, prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function fixture(t) {
  const root = await temp(t, 'ba58-review-');
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
const gateOk = () => ({
  ok: true,
  failures: [],
  delta: { droppedSentences: 0, changedNumbers: [], lostCaveats: 0, blockWords: 12 },
});

/** A page with four dated sections, so an apply writes a new archive and then the page. */
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

async function seed({ vault, stateDir, page, proposal }) {
  const text = await readFile(join(vault, page), 'utf8');
  return createStore(stateDir).save({
    batch: '2026-W47',
    page,
    baseHash: createHash('sha256').update(text).digest('hex'),
    createdAt: NOW.toISOString(),
    proposal,
    gates: gateOk(),
    shadow: false,
  });
}

/** A fresh lexical index of a wiki directory, built by the same Core code as `wikiIndex` in review.mjs. */
const indexOf = (wikiDir, now) => buildIndex(loadPagesDetailed(wikiDir).pages, { now, exclude: DEFAULT_EXCLUDE_WIKI });

test('accept fails E_APPLY_VERIFY and restores both files when the written page bytes differ', async (t) => {
  const f = await fixture(t);
  const lp = await longPage(f);
  const saved = await seed({ ...f, page: lp.page, proposal: lp.proposal });
  const pageBefore = await readFile(join(f.vault, lp.page));
  let calls = 0;
  const dependencies = {
    atomicWriteFile: async (file, data, ...rest) => {
      calls++;
      // The archive is written first, the page second: only the page write is tampered with.
      const bytes = calls === 2 ? Buffer.from('tampered page bytes\n') : data;
      return atomicWriteFile(file, bytes, ...rest);
    },
  };

  await assert.rejects(
    acceptProposal({ ...f, id: saved.id, now: NOW, dependencies }),
    (error) => error.code === 'E_APPLY_VERIFY'
  );

  assert.deepEqual(await readFile(join(f.vault, lp.page)), pageBefore);
  await assert.rejects(readFile(join(f.vault, lp.archive)), (error) => error.code === 'ENOENT');
  const record = await createStore(f.stateDir).get(saved.id);
  assert.notEqual(record.status, 'accepted');
  assert.equal(record.status, 'reverted');
});

test('accept reports the retrieval regression and restores both files when the page drops out of the top ten', async (t) => {
  const f = await fixture(t);
  const lp = await longPage(f);
  const saved = await seed({ ...f, page: lp.page, proposal: lp.proposal });
  const pageBefore = await readFile(join(f.vault, lp.page));

  // The post-apply index is built from a copy of the Wiki plus decoy pages that outrank the target for its own queries.
  const afterVault = join(f.root, 'after-vault');
  await cp(join(f.vault, 'wiki'), join(afterVault, 'wiki'), { recursive: true });
  for (let index = 1; index <= 12; index++) {
    const text = [
      '---',
      'type: concept',
      'title: Long page',
      'status: confirmed',
      '---',
      `# Long page ${index}`,
      '',
      ...Array.from({ length: 40 }, () => 'Long page service stable note.'),
    ].join('\n');
    await writeFile(join(afterVault, 'wiki', 'concepts', `decoy-${index}.md`), text);
  }
  let calls = 0;
  const dependencies = {
    wikiIndex: (root, now) => {
      calls++;
      return indexOf(join(calls === 1 ? root : afterVault, 'wiki'), now);
    },
  };

  await assert.rejects(
    acceptProposal({ ...f, id: saved.id, now: NOW, dependencies }),
    (error) => error.code === 'E_APPLY_REGRESSION' && error.checks.includes('retrieval')
  );

  assert.deepEqual(await readFile(join(f.vault, lp.page)), pageBefore);
  await assert.rejects(readFile(join(f.vault, lp.archive)), (error) => error.code === 'ENOENT');
  assert.equal((await createStore(f.stateDir).get(saved.id)).status, 'reverted');
});
