// SPDX-License-Identifier: MIT
// BA-25 hypothesis 2 (page loss): two separate MCP server processes read the same page hash and both write different
// content with expectedSha256 at the same time, >= 50 rounds. Candidate criterion, per round: exactly one success and one
// E_CONFLICT; the final file is the winner's content; lost updates = 0; the E_CONFLICT reply has no page content or hash;
// the log has no entry for the failed write.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  readText,
  makeFixture,
  openClient,
  call,
  textOf,
  isErr,
  okJson,
  page,
  metric,
  WT,
  sha256,
} from './harness.mjs';

const ROUNDS = 50;
const PAGE = 'concepts/ba25-cas.md';
const PAGE_FILE = (f) => `${f.wikiDir}/${PAGE}`;

async function readShaFromProcess(client, f, root) {
  const res = await call(client, 'wiki_read_page', { path: PAGE });
  const disk = sha256(await readFile(PAGE_FILE(f)));
  if (root === WT) {
    const reported = okJson(res).sha256;
    assert.equal(reported, disk, 'wiki_read_page sha256 equals the hash of the bytes on disk');
  }
  return disk;
}

async function racePage(t, root) {
  const f = await makeFixture(t);
  const a = await openClient(t, root, f, 'proc-a');
  const b = await openClient(t, root, f, 'proc-b');
  await call(a.client, 'wiki_write_page', { path: PAGE, content: page('BA25 CAS', 'Base.') });
  const stats = {
    rounds: ROUNDS,
    successes: 0,
    conflicts: 0,
    otherErrors: [],
    lostUpdates: 0,
    badWinner: 0,
    conflictLeaks: 0,
    logEntriesForFailed: 0,
    perRoundSuccessHistogram: {},
  };
  for (let r = 0; r < ROUNDS; r++) {
    await call(a.client, 'wiki_write_page', { path: PAGE, content: page('BA25 CAS', `Base ${r}.`) });
    const sha = await readShaFromProcess(a.client, f, root);
    assert.equal(await readShaFromProcess(b.client, f, root), sha, 'both processes read the same hash');
    const logBefore = (await readText(f.logFile))
      .split('\n')
      .filter((line) => line.includes('update-page') && line.includes('ba25-cas')).length;
    const markerA = `Writer one round ${r}.`,
      markerB = `Writer two round ${r}.`;
    const [x, y] = await Promise.all([
      call(a.client, 'wiki_update_page', { path: PAGE, content: page('BA25 CAS', markerA), expectedSha256: sha }),
      call(b.client, 'wiki_update_page', { path: PAGE, content: page('BA25 CAS', markerB), expectedSha256: sha }),
    ]);
    const results = [x, y];
    const markers = [markerA, markerB];
    const successes = [];
    let conflicts = 0;
    results.forEach((res, i) => {
      if (!res.isError) {
        successes.push(markers[i]);
        return;
      }
      if (isErr(res, 'E_CONFLICT')) {
        conflicts++;
        const text = textOf(res);
        if (text.includes('Writer') || /[0-9a-f]{64}/.test(text)) stats.conflictLeaks++;
      } else stats.otherErrors.push(textOf(res).slice(0, 120));
    });
    stats.successes += successes.length;
    stats.conflicts += conflicts;
    stats.perRoundSuccessHistogram[successes.length] = (stats.perRoundSuccessHistogram[successes.length] ?? 0) + 1;
    const final = await readText(PAGE_FILE(f));
    const landed = [markerA, markerB].filter((m) => final.includes(m));
    if (successes.length === 1 && landed.length !== 1) stats.badWinner++;
    if (successes.length === 1 && !final.includes(successes[0])) stats.badWinner++;
    // A successful write whose content is not in the final file is a lost update.
    for (const s of successes) if (!final.includes(s)) stats.lostUpdates++;
    const logAfter = (await readText(f.logFile))
      .split('\n')
      .filter((line) => line.includes('update-page') && line.includes('ba25-cas')).length;
    if (logAfter - logBefore !== successes.length)
      stats.logEntriesForFailed += Math.abs(logAfter - logBefore - successes.length);
  }
  return stats;
}

test('H2 candidate: two processes, 50 rounds, one success + one E_CONFLICT per round, zero lost updates', async (t) => {
  const stats = await racePage(t, WT);
  metric('H2.candidate', stats);
  assert.deepEqual(stats.otherErrors, [], 'no unexpected error');
  assert.deepEqual(stats.perRoundSuccessHistogram, { 1: ROUNDS }, 'exactly one success in every round');
  assert.equal(stats.successes, ROUNDS);
  assert.equal(stats.conflicts, ROUNDS, 'exactly one E_CONFLICT in every round');
  assert.equal(stats.lostUpdates, 0, 'no lost update');
  assert.equal(stats.badWinner, 0, 'final file is the winner content');
  assert.equal(stats.conflictLeaks, 0, 'E_CONFLICT carries no page content and no hash');
  assert.equal(stats.logEntriesForFailed, 0, 'failed write never reaches the log');
});
