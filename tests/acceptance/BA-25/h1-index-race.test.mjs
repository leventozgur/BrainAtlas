// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { readText, makeFixture, openClient, call, textOf, invalidIndexLines, metric, WT } from './harness.mjs';

const ROUNDS = 50;

async function raceIndex(t, root) {
  const f = await makeFixture(t);
  const a = await openClient(t, root, f, 'proc-a');
  const b = await openClient(t, root, f, 'proc-b');
  let lost = 0,
    failed = 0,
    invalidRounds = 0,
    invalidSamples = [];
  for (let r = 0; r < ROUNDS; r++) {
    const nameA = `ba25 idx a ${r}`,
      nameB = `ba25 idx b ${r}`;
    const [ra, rb] = await Promise.all([
      call(a.client, 'wiki_create', { type: 'concept', name: nameA, content: `Body A ${r}.` }),
      call(b.client, 'wiki_create', { type: 'concept', name: nameB, content: `Body B ${r}.` }),
    ]);
    for (const [result, name] of [
      [ra, nameA],
      [rb, nameB],
    ]) {
      if (result.isError) {
        failed++;
        continue;
      }
      const link = `](concepts/${name.replace(/ /g, '-')}.md)`;
      if (!(await readText(f.indexFile)).includes(link)) lost++;
    }
    const index = await readText(f.indexFile);
    const bad = invalidIndexLines(index);
    if (bad.length) {
      invalidRounds++;
      if (invalidSamples.length < 3) invalidSamples.push(bad.slice(0, 2));
    }
  }
  const listed = JSON.parse(textOf(await call(a.client, 'wiki_list_pages', {}))).pages.filter((p) =>
    /wiki\/concepts\/ba25-idx-[ab]-\d+\.md$/.test(p)
  ).length;
  return { rounds: ROUNDS, lost, failed, invalidRounds, invalidSamples, listedNewPages: listed };
}

test('H1 candidate: two processes, 50 rounds, no lost index line and valid Markdown every round', async (t) => {
  const result = await raceIndex(t, WT);
  metric('H1.candidate', result);
  assert.equal(result.failed, 0, 'no create call may fail');
  assert.equal(result.lost, 0, 'no lost index line');
  assert.equal(result.invalidRounds, 0, `index must stay valid Markdown: ${JSON.stringify(result.invalidSamples)}`);
  assert.equal(result.listedNewPages, ROUNDS * 2, 'every created page is listed');
});
