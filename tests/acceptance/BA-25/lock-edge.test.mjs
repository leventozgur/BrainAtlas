// SPDX-License-Identifier: MIT
// BA-25 hypothesis 3 (guard), part B: lock visibility, refusals, takeover, busy, cleanup, expectedSha256 edges, read-only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, rm, stat, utimes, readdir, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { makeFixture, openClient, call, textOf, isErr, okJson, page, liveChild, deadPid, filesUnder, sha256, readText, WT, LOCK_NAME } from './harness.mjs';

const lockBody = (pid, time, token = 'foreign') => `${JSON.stringify({ pid, time, token })}\n`;
const EN = 'entities/lock-probe.md';

// ---------- visibility and refusals while a live, fresh lock is held by another process ----------

test('lock file is invisible to listing, query, status, maintain and recap, and unreachable through page tools', async (t) => {
  const f = await makeFixture(t);
  const c = await openClient(t, WT, f);
  const holder = liveChild(t);
  const body = lockBody(holder, Date.now());
  await writeFile(f.lockFile, body);

  const list = okJson(await call(c.client, 'wiki_list_pages', {})).pages;
  assert.equal(list.some((p) => p.includes(LOCK_NAME)), false, 'wiki_list_pages hides the lock');
  const query = okJson(await call(c.client, 'wiki_query', { query: 'synthetic bilingual', limit: 20 })).results;
  assert.equal(query.some((r) => String(r.path).includes(LOCK_NAME)), false, 'wiki_query hides the lock');
  const status = okJson(await call(c.client, 'wiki_status', {}));
  assert.equal(status.pageCount, list.length, 'wiki_status counts the same pages as the listing');
  assert.ok(okJson(await call(c.client, 'wiki_read_index', {})).content.length > 0);

  // Reads and writes through the page tools refuse the lock file name in every spelling.
  for (const path of [`wiki/${LOCK_NAME}`, LOCK_NAME, `entities/${LOCK_NAME}`]) {
    assert.ok(isErr(await call(c.client, 'wiki_read_page', { path }), 'E_PATH_ESCAPE'), `read ${path}`);
    assert.ok(isErr(await call(c.client, 'wiki_write_page', { path, content: page('X', 'x') }), 'E_PATH_ESCAPE'), `write ${path}`);
    assert.ok(isErr(await call(c.client, 'wiki_update_page', { path, content: page('X', 'x') }), 'E_PATH_ESCAPE'), `update ${path}`);
  }
  assert.equal(await readText(f.lockFile), body, 'refusals never touch the lock file');

  // brainatlas maintain (CLI, read-only report) and the session-start recap hook must not list the lock file.
  const cli = spawnSync(process.execPath, [join(WT, 'packages/cli/bin/brainatlas.mjs'), 'maintain', '--json', '--vault', f.vault],
    { cwd: WT, env: f.env, encoding: 'utf8' });
  assert.equal(cli.status, 0, `maintain exited ${cli.status}: ${cli.stderr.slice(0, 200)}`);
  assert.equal(cli.stdout.includes(LOCK_NAME), false, 'maintain output does not name the lock');
  const { buildRecap } = await import(pathToFileURL(join(WT, 'packages/hooks/src/recap.mjs')).href);
  const recap = await buildRecap({ vaultPath: f.vault, stateDir: join(f.dir, 'state') });
  assert.equal(recap.includes(LOCK_NAME), false, 'recap hook output does not name the lock');
});

// ---------- takeover of stale locks and bounded refusal of live fresh locks ----------

test('a lock held by a dead pid is taken over and removed after the write', async (t) => {
  const f = await makeFixture(t);
  const c = await openClient(t, WT, f);
  await writeFile(f.lockFile, lockBody(await deadPid(), Date.now(), 'ghost'));
  assert.equal(okJson(await call(c.client, 'wiki_write_page', { path: EN, content: page('Lock Probe', 'after dead holder') })).written, true);
  assert.equal(existsSync(f.lockFile), false, 'no lock left after a successful write');
});

test('a live lock older than 30 seconds is taken over', async (t) => {
  const f = await makeFixture(t);
  const c = await openClient(t, WT, f);
  await writeFile(f.lockFile, lockBody(liveChild(t), Date.now() - 40_000, 'old'));
  assert.equal(okJson(await call(c.client, 'wiki_write_page', { path: EN, content: page('Lock Probe', 'after old lock') })).written, true);
  assert.equal(existsSync(f.lockFile), false);
});

test('an unreadable lock file that is older than 30 seconds is taken over', async (t) => {
  const f = await makeFixture(t);
  const c = await openClient(t, WT, f);
  await writeFile(f.lockFile, 'not json at all');
  const old = new Date(Date.now() - 40_000);
  await utimes(f.lockFile, old, old);
  assert.equal(okJson(await call(c.client, 'wiki_update_index', {})).indexed > 0, true);
  assert.equal(existsSync(f.lockFile), false);
});

test('a live fresh lock makes writes fail with E_BUSY, writes nothing, and keeps the foreign lock intact', async (t) => {
  const f = await makeFixture(t);
  const c = await openClient(t, WT, f);
  const body = lockBody(liveChild(t), Date.now(), 'busy-holder');
  await writeFile(f.lockFile, body);
  const logBefore = await readText(f.logFile);
  const indexBefore = await readText(f.indexFile);

  const write = await call(c.client, 'wiki_write_page', { path: EN, content: page('Lock Probe', 'must not land') });
  assert.ok(isErr(write, 'E_BUSY'), `write refused: ${textOf(write)}`);
  assert.equal(existsSync(join(f.wikiDir, EN)), false, 'refused write leaves no page');
  const index = await call(c.client, 'wiki_update_index', {});
  assert.ok(isErr(index, 'E_BUSY'), 'index update refused');
  const create = await call(c.client, 'wiki_create_concept', { name: 'Busy Concept', content: 'x' });
  assert.ok(isErr(create, 'E_BUSY'), 'create refused');
  const update = await call(c.client, 'wiki_update_page', { path: 'concepts/sample-02.md', content: page('x', 'y') });
  assert.ok(isErr(update, 'E_BUSY'), 'update refused');

  assert.equal(await readText(f.logFile), logBefore, 'refused writes never reach the log');
  assert.equal(await readText(f.indexFile), indexBefore, 'refused writes never touch the index');
  assert.equal(await readText(f.lockFile), body, 'refusal does not delete the foreign lock');
  assert.ok(okJson(await call(c.client, 'wiki_read_page', { path: 'wiki/concepts/sample-02.md' })).content.length > 0, 'reads still work while busy');

  // Once the foreign lock is gone, the same write succeeds.
  await rm(f.lockFile);
  assert.equal(okJson(await call(c.client, 'wiki_write_page', { path: EN, content: page('Lock Probe', 'lands now') })).written, true);
});

// ---------- cleanup after success and failure, expectedSha256 edges ----------

test('no lock file remains after successful and failed calls, including internal failures inside the lock', async (t) => {
  const f = await makeFixture(t);
  const c = await openClient(t, WT, f);
  const noLock = () => assert.equal(existsSync(f.lockFile), false, 'lock file must not remain');
  const run = async (name, args) => { const r = await call(c.client, name, args); noLock(); return r; };

  assert.equal(okJson(await run('wiki_write_page', { path: EN, content: page('Lock Probe', 'a') })).written, true);
  assert.equal(okJson(await run('wiki_update_page', { path: EN, patch: { append: '\nb' } })).updated, true);
  assert.ok(isErr(await run('wiki_update_page', { path: EN }), 'E_INVALID_INPUT'));
  assert.ok(isErr(await run('wiki_write_page', { path: EN, content: page('Lock Probe', 'a'), expectedSha256: 'f'.repeat(64) }), 'E_CONFLICT'));
  assert.ok(isErr(await run('wiki_write_page', { path: 'concepts/never-here.md', content: page('N', 'n'), expectedSha256: 'a'.repeat(64) }), 'E_CONFLICT'));
  assert.ok(isErr(await run('wiki_write_page', { path: '../escape.md', content: page('E', 'e') }), 'E_PATH_ESCAPE'));
  assert.ok(isErr(await run('wiki_create_entity', { name: 'Dup Probe', content: 'one' })) === false);
  assert.ok(isErr(await run('wiki_create_entity', { name: 'Dup Probe', content: 'two' }), 'E_ALREADY_EXISTS'));
  // Crosslink to a missing target fails inside the lock; the lock must still be released.
  await run('wiki_write_page', { path: 'entities/xl.md', content: page('XL', 'see [gone](../concepts/does-not-exist.md)') });
  assert.equal(textOf(await run('wiki_add_crosslinks', { path: 'entities/xl.md' })).startsWith('E_'), true, 'missing crosslink target refused');
  assert.equal(okJson(await run('wiki_write_page', { path: EN, content: page('Lock Probe', 'after failures') })).written, true, 'later writes still work');
});

test('expectedSha256: uppercase hex matches, a malformed value is rejected, a missing page is E_CONFLICT with no side effects', async (t) => {
  const f = await makeFixture(t);
  const c = await openClient(t, WT, f);
  await call(c.client, 'wiki_write_page', { path: EN, content: page('Lock Probe', 'base') });
  const sha = sha256(await readFile(join(f.wikiDir, EN)));
  const upper = await call(c.client, 'wiki_update_page', { path: EN, content: page('Lock Probe', 'upper ok'), expectedSha256: sha.toUpperCase() });
  assert.equal(okJson(upper).updated, true);
  assert.equal(okJson(upper).sha256, sha256(await readFile(join(f.wikiDir, EN))), 'reply sha256 is the hash of the new bytes');
  const bad = await call(c.client, 'wiki_write_page', { path: EN, content: page('Lock Probe', 'x'), expectedSha256: 'not-a-hash' });
  assert.equal(bad.isError, true, 'malformed expectedSha256 is refused');
  assert.match(await readText(join(f.wikiDir, EN)), /upper ok/, 'malformed hash changed nothing');
  const logBefore = await readText(f.logFile);
  const missing = await call(c.client, 'wiki_update_page', { path: 'concepts/absent-page.md', content: page('A', 'a'), expectedSha256: sha });
  assert.ok(isErr(missing, 'E_CONFLICT'));
  assert.equal(textOf(missing).includes('upper ok'), false, 'conflict reply has no page content');
  assert.equal(existsSync(join(f.wikiDir, 'concepts/absent-page.md')), false, 'missing page is not created');
  assert.equal(await readText(f.logFile), logBefore, 'missing-page conflict is not logged');
});

// ---------- read-only mode ----------

test('readOnly mode exposes no write tools and the lock is never created', async (t) => {
  const f = await makeFixture(t, { readOnly: true });
  const c = await openClient(t, WT, f);
  const names = (await c.client.listTools()).tools.map((x) => x.name).sort();
  assert.deepEqual(names, ['wiki_lint', 'wiki_list_pages', 'wiki_query', 'wiki_read_index', 'wiki_read_page', 'wiki_status']);
  assert.equal(existsSync(f.lockFile), false);
});

// ---------- file mode bits ----------

test('existing file permission bits survive page and index writes', async (t) => {
  const f = await makeFixture(t);
  const c = await openClient(t, WT, f);
  await call(c.client, 'wiki_write_page', { path: EN, content: page('Lock Probe', 'mode') });
  await chmod(join(f.wikiDir, EN), 0o640);
  await call(c.client, 'wiki_write_page', { path: EN, content: page('Lock Probe', 'mode two') });
  assert.equal((await stat(join(f.wikiDir, EN))).mode & 0o777, 0o640, 'page mode kept');
  await chmod(f.indexFile, 0o600);
  assert.equal(okJson(await call(c.client, 'wiki_update_index', {})).indexed > 0, true);
  assert.equal((await stat(f.indexFile)).mode & 0o777, 0o600, 'index mode kept');
});
