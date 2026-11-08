// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { initVault, parseFrontmatter, readPage, listPages, appendLog, upsertIndexEntry } from '../../../packages/core/src/vault/index.mjs';

test('initVault creates the layout and never overwrites existing files', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ba-vault-')); t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'wiki'), { recursive: true }); await writeFile(join(dir, 'wiki/index.md'), 'user data\n');
  await initVault(dir); await initVault(dir);
  assert.equal(await readFile(join(dir, 'wiki/index.md'), 'utf8'), 'user data\n');
  assert.equal((await readFile(join(dir, 'AGENTS.md'), 'utf8')).includes('Retrieval first'), true);
  for (const p of ['wiki/entities','wiki/concepts','wiki/sources','wiki/summaries','wiki/queries','raw','inbox','planning','planning/backlog.md','wiki/log.md']) await stat(join(dir,p));
});

test('frontmatter parses safely, preserves date-only values, and reports malformed YAML without content', () => {
  const source = `---\ntype: entity\nday: 2026-01-02\n---\nBody remains separate.`;
  const parsed = parseFrontmatter(source);
  assert.equal(parsed.data.day, '2026-01-02'); assert.equal(parsed.body, 'Body remains separate.'); assert.deepEqual(parsed.errors, []);
  const script = `import {parseFrontmatter} from './packages/core/src/vault/index.mjs'; process.stdout.write(parseFrontmatter('---\\nd: 2026-01-02\\n---').data.d)`;
  for (const TZ of ['Pacific/Kiritimati', 'America/Adak']) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: process.cwd(), env: { ...process.env, TZ }, encoding: 'utf8' });
    assert.equal(result.status, 0); assert.equal(result.stdout, '2026-01-02');
  }
  const broken = parseFrontmatter('---\nkey: [\n---\nPRIVATE BODY');
  assert.equal(broken.errors[0].code, 'E_FRONTMATTER_YAML'); assert.equal(JSON.stringify(broken.errors).includes('PRIVATE BODY'), false);
});

test('read, list, append-only log, and index upsert work on vault-relative paths', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ba-vault-')); t.after(() => rm(dir, { recursive: true, force: true }));
  await initVault(dir); await writeFile(join(dir, 'wiki/entities/a.md'), '---\ntitle: A\n---\nbody');
  assert.equal((await readPage(dir, 'wiki/entities/a.md')).data.title, 'A');
  assert.ok((await listPages(dir)).includes('wiki/entities/a.md'));
  await appendLog(dir, { action: 'created', path: 'wiki/entities/a.md' }, { now: new Date('2026-01-02T00:00:00Z') });
  await appendLog(dir, { action: 'updated' }, { now: new Date('2026-01-03T00:00:00Z') });
  assert.equal((await readFile(join(dir, 'wiki/log.md'), 'utf8')).match(/2026-/g).length, 2);
  await upsertIndexEntry(dir, { path: 'wiki/entities/a.md', title: 'A' }); await upsertIndexEntry(dir, { path: 'wiki/entities/a.md', title: 'A2' });
  const index = await readFile(join(dir, 'wiki/index.md'), 'utf8'); assert.equal(index.match(/wiki\/entities\/a.md/g).length, 1); assert.match(index, /A2/);
  await assert.rejects(readPage(dir, '../escape.md'), (e) => e.code === 'E_PATH_ESCAPE');
});

test('interrupted atomic log replacement preserves the previous complete log', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ba-vault-')); t.after(() => rm(dir, { recursive: true, force: true }));
  await initVault(dir);
  const file = join(dir, 'wiki/log.md'); const before = await readFile(file, 'utf8');
  await assert.rejects(appendLog(dir, { action: 'updated' }, { atomicWriter: async () => { throw new Error('simulated interruption'); } }), /simulated interruption/);
  assert.equal(await readFile(file, 'utf8'), before);
});
