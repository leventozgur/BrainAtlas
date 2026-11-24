// SPDX-License-Identifier: MIT
// BA-25: two real MCP server processes writing the same vault. Index creates must not lose lines; a stale-hash update must
// be refused with E_CONFLICT; a stale or dead write lock must be taken over; a busy lock must refuse with E_BUSY; the lock
// file is never listed as a page. Temporary HOME and vault, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, utimes, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { defaultConfig } from '../../packages/core/src/config/index.mjs';
import { clockShiftEnv } from '../helpers/shift-clock.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const LOCK = '.brainatlas-write.lock';
const sha = (text) => createHash('sha256').update(text).digest('hex');

async function fixture(t) {
  const home = await mkdtemp(resolve(tmpdir(), 'ba25-conc-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const vault = resolve(home, 'vault');
  const wiki = resolve(vault, 'wiki');
  await mkdir(wiki, { recursive: true });
  await writeFile(resolve(wiki, 'log.md'), '# Wiki log\n');
  await writeFile(resolve(wiki, 'index.md'), '# Wiki Index\n');
  const config = defaultConfig('lite');
  config.vault.path = vault;
  config.readOnly = false;
  const configFile = resolve(home, 'config.json');
  await writeFile(configFile, JSON.stringify(config));
  const start = async (name) => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve(root, 'packages/mcp/bin/brainatlas-mcp.mjs')],
      cwd: root,
      env: clockShiftEnv({
        HOME: home,
        BRAINATLAS_CONFIG: configFile,
        BRAINATLAS_VAULT: vault,
        PATH: process.env.PATH ?? '',
      }),
      stderr: 'pipe',
    });
    const client = new Client({ name, version: '1.0.0' });
    await client.connect(transport);
    t.after(async () => {
      await client.close();
    });
    return client;
  };
  return { home, wiki, a: await start('ba25-a'), b: await start('ba25-b') };
}

async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  return {
    isError: result.isError === true,
    text: result.content[0].text,
    data: result.isError ? undefined : JSON.parse(result.content[0].text),
  };
}

async function ok(client, name, args = {}) {
  const result = await call(client, name, args);
  assert.equal(result.isError, false, result.text);
  return result.data;
}

test('two processes creating pages at once keep every index line and a well-formed index', async (t) => {
  const { wiki, a, b } = await fixture(t);
  const ROUNDS = 50;
  for (let i = 0; i < ROUNDS; i++) {
    const [ra, rb] = await Promise.all([
      call(a, 'wiki_create_entity', { name: `Ent ${i}`, content: `---\ntitle: Ent ${i}\n---\nx\n` }),
      call(b, 'wiki_create_concept', { name: `Con ${i}`, content: `---\ntitle: Con ${i}\n---\ny\n` }),
    ]);
    assert.equal(ra.isError, false, ra.text);
    assert.equal(rb.isError, false, rb.text);
  }
  const index = await readFile(resolve(wiki, 'index.md'), 'utf8');
  for (let i = 0; i < ROUNDS; i++) {
    assert.ok(index.includes(`(entities/ent-${i}.md)`), `entity ${i} line lost`);
    assert.ok(index.includes(`(concepts/con-${i}.md)`), `concept ${i} line lost`);
  }
  assert.ok(index.startsWith('# Wiki Index\n'));
  assert.ok(index.endsWith('\n'));
  assert.equal(index.split('\n').filter((line) => /^- \[/.test(line)).length, ROUNDS * 2);
});

test('a stale expectedSha256 loses the race with E_CONFLICT and never overwrites the winner', async (t) => {
  const { wiki, a, b } = await fixture(t);
  await ok(a, 'wiki_write_page', { path: 'concepts/shared.md', content: '---\ntitle: Shared\n---\nbase\n' });
  const ROUNDS = 50;
  for (let i = 0; i < ROUNDS; i++) {
    const base = `---\ntitle: Shared\n---\nbase ${i}\n`;
    await writeFile(resolve(wiki, 'concepts/shared.md'), base);
    const readA = await ok(a, 'wiki_read_page', { path: 'concepts/shared.md' });
    const readB = await ok(b, 'wiki_read_page', { path: 'concepts/shared.md' });
    assert.equal(readA.sha256, sha(base));
    assert.equal(readB.sha256, sha(base));
    const [x, y] = await Promise.all([
      call(a, 'wiki_update_page', {
        path: 'concepts/shared.md',
        content: readA.content.replace('base', 'A-edit'),
        expectedSha256: readA.sha256,
      }),
      call(b, 'wiki_update_page', {
        path: 'concepts/shared.md',
        content: readB.content.replace('base', 'B-edit'),
        expectedSha256: readB.sha256,
      }),
    ]);
    const outcomes = [x, y];
    assert.equal(outcomes.filter((r) => !r.isError).length, 1, 'exactly one writer must succeed');
    const loser = outcomes.find((r) => r.isError);
    assert.ok(loser.text.startsWith('E_CONFLICT:'), loser.text);
    assert.ok(
      !loser.text.includes('edit') && !loser.text.includes(readA.sha256),
      'E_CONFLICT must not echo content or hash'
    );
    const final = await readFile(resolve(wiki, 'concepts/shared.md'), 'utf8');
    const winner = outcomes.find((r) => !r.isError) === x ? 'A-edit' : 'B-edit';
    assert.ok(final.includes(winner), 'the winning edit must be on disk');
    assert.ok(!final.includes(winner === 'A-edit' ? 'B-edit' : 'A-edit'), 'the losing edit must not be on disk');
  }
});

test('a write lock left by a dead process does not block the write', async (t) => {
  const { wiki, a } = await fixture(t);
  const { spawn } = await import('node:child_process');
  const dead = spawn(process.execPath, ['-e', '0']);
  await new Promise((done) => dead.on('exit', done));
  await writeFile(resolve(wiki, LOCK), JSON.stringify({ pid: dead.pid, time: Date.now(), token: 'x' }));
  await ok(a, 'wiki_create_entity', { name: 'After Crash', content: '---\ntitle: After Crash\n---\nz\n' });
});

test('a lock without a pid is taken over once it is older than 30 seconds', async (t) => {
  const { wiki, a } = await fixture(t);
  const lockPath = resolve(wiki, LOCK);
  await writeFile(lockPath, '{}\n');
  const old = new Date(Date.now() - 60_000);
  await utimes(lockPath, old, old);
  await ok(a, 'wiki_create_entity', { name: 'Old Lock', content: '---\ntitle: Old Lock\n---\nz\n' });
  await assert.rejects(
    readFile(lockPath, 'utf8'),
    { code: 'ENOENT' },
    'the stale lock must be removed after the write'
  );
});

test('a fresh lock held by a live process refuses the write with E_BUSY', async (t) => {
  const { wiki, a } = await fixture(t);
  await writeFile(resolve(wiki, LOCK), JSON.stringify({ pid: process.pid, time: Date.now(), token: 'held' }));
  const result = await call(a, 'wiki_create_entity', { name: 'Blocked', content: '---\ntitle: Blocked\n---\nz\n' });
  assert.equal(result.isError, true);
  assert.ok(result.text.startsWith('E_BUSY:'), result.text);
  await assert.rejects(
    readFile(resolve(wiki, 'blocked.md'), 'utf8'),
    { code: 'ENOENT' },
    'nothing is written while busy'
  );
  assert.equal(JSON.parse(await readFile(resolve(wiki, LOCK), 'utf8')).token, 'held', 'a live lock is not taken over');
});

test('the lock file is not a page: not listed, not counted, not readable through the Wiki tools', async (t) => {
  const { wiki, a } = await fixture(t);
  await ok(a, 'wiki_create_concept', { name: 'Visible', content: '---\ntitle: Visible\n---\nvisible body\n' });
  // A live lock held by this test process is present on disk while the read-only tools run.
  await writeFile(resolve(wiki, LOCK), JSON.stringify({ pid: process.pid, time: Date.now(), token: 'held' }));
  t.after(() => rm(resolve(wiki, LOCK), { force: true }));
  const listed = await ok(a, 'wiki_list_pages');
  assert.deepEqual(listed.pages, ['wiki/concepts/visible.md']);
  const status = await ok(a, 'wiki_status');
  assert.equal(status.pageCount, 1);
  assert.equal(status.indexCoveragePct, 100);
  const read = await call(a, 'wiki_read_page', { path: LOCK });
  assert.equal(read.isError, true, 'the lock file must not be readable as a Wiki page');
  assert.ok(!read.text.includes('held'), 'the lock contents must not leak');
});
