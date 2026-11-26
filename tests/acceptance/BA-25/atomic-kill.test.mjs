// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  makeFixture,
  openClient,
  call,
  okJson,
  page,
  rawServer,
  filesUnder,
  sha256,
  WT,
  LOCK_NAME,
} from './harness.mjs';

const ITER = 12;
const END = 'END-MARK-BA25';
const TARGET = 'concepts/atomic-probe.md';

test('SIGKILL during a large page write leaves old or whole new content and a recoverable lock', async (t) => {
  const f = await makeFixture(t);
  const target = join(f.wikiDir, TARGET);
  const setup = await openClient(t, WT, f);
  await call(setup.client, 'wiki_write_page', { path: TARGET, content: page('Atomic', 'OLD BODY.') });
  const oldBytes = await readFile(target);
  const oldSha = sha256(oldBytes);
  const newContent = page('Atomic', `${'a'.repeat(8 * 1024 * 1024)}\n${END}\n`);
  const tally = {
    old: 0,
    new: 0,
    partial: 0,
    killedInTempWindow: 0,
    tempLeftovers: 0,
    lockLeftByKilledHolder: 0,
    recoveredAfterKill: 0,
    controlWhole: false,
  };

  for (let i = 0; i < ITER; i++) {
    await writeFile(target, oldBytes);
    const srv = rawServer(WT, f.env);
    await srv.handshake();
    const tempsBefore = new Set((await readdir(join(f.wikiDir, 'concepts'))).filter((n) => n.endsWith('.tmp')));
    let done = false;
    const pending = srv.callTool('wiki_write_page', { path: TARGET, content: newContent }).then(() => {
      done = true;
    });
    const deadline = Date.now() + 60_000;
    let sawTemp = false;
    while (!done && Date.now() < deadline) {
      const names = await readdir(join(f.wikiDir, 'concepts'));
      if (names.some((n) => n.startsWith('.atomic-probe.md.') && n.endsWith('.tmp') && !tempsBefore.has(n))) {
        sawTemp = true;
        break;
      }
    }
    const inWindow = sawTemp && !done;
    srv.kill();
    await srv.exited;
    pending.catch(() => {});
    if (inWindow) tally.killedInTempWindow++;

    if (existsSync(join(f.wikiDir, LOCK_NAME))) tally.lockLeftByKilledHolder++;
    const bytes = await readFile(target);
    if (sha256(bytes) === oldSha) tally.old++;
    else if (bytes.toString('utf8').includes(END) && bytes.toString('utf8').includes('title: Atomic')) tally.new++;
    else tally.partial++;

    const leftovers = (await readdir(join(f.wikiDir, 'concepts'))).filter((n) => n.endsWith('.tmp'));
    tally.tempLeftovers += leftovers.length;
    const after = await openClient(t, WT, f, `after-kill-${i}`);
    const listed = okJson(await call(after.client, 'wiki_list_pages', {})).pages;
    assert.equal(
      listed.some((p) => p.endsWith('.tmp') || p.includes(LOCK_NAME)),
      false,
      'temp and lock files are never listed'
    );
    const next = await call(after.client, 'wiki_write_page', { path: TARGET, content: page('Atomic', 'RECOVERED.') });
    assert.notEqual(next.isError, true, 'next process writes after the kill');
    if (next.isError !== true) tally.recoveredAfterKill++;
    assert.equal(existsSync(join(f.wikiDir, LOCK_NAME)), false, 'no lock after recovery');
    await after.client.close();
  }
  await writeFile(target, oldBytes);
  const control = await openClient(t, WT, f, 'control');
  assert.notEqual((await call(control.client, 'wiki_write_page', { path: TARGET, content: newContent })).isError, true);
  const whole = (await readFile(target)).toString('utf8');
  tally.controlWhole = whole.includes(END) && whole.includes('title: Atomic');
  console.log(`BA25-METRIC atomic=${JSON.stringify(tally)}`);
  assert.equal(tally.controlWhole, true, 'classifier recognises a complete new page');
  assert.equal(tally.partial, 0, 'never a partial page');
  assert.equal(tally.recoveredAfterKill, ITER, 'every kill is recovered by the next writer');
  assert.ok(tally.killedInTempWindow > 0, 'at least one kill landed inside the temporary-file window');
  assert.equal(tally.old + tally.new, ITER);
  const pages = (await filesUnder(f.wikiDir)).filter((p) => p.endsWith('.md'));
  assert.ok(pages.every((p) => !p.endsWith('.tmp')));
});
