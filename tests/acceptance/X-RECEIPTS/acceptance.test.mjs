import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commands, onSessionEnd, approveReceipt, rejectReceipt, listReceipts, showReceipt } from '../../../modules/receipts/src/index.mjs';
import { initVault } from '../../../packages/core/src/vault/index.mjs';
import { checkPage } from '../../../packages/core/src/okf/index.mjs';

async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), 'receipt-accept-'));
  try {
    const stateDir = join(root, 'state'), vault = join(root, 'vault'), home = join(root, 'home');
    await mkdir(stateDir); await mkdir(home); await initVault(vault);
    const ctx = { paths: { stateDir }, config: { vault: { path: vault } }, env: { HOME: home }, now: new Date('2026-11-08T10:00:00Z') };
    await fn({ root, stateDir, vault, home, ctx });
  } finally { await rm(root, { recursive: true, force: true }); }
}
const candidate = { title: 'Cache proposal', summary: 'Bound the cache.', suggestedPath: 'wiki/concepts/cache.md', sources: ['src/cache.mjs:7'] };
const queue = (ctx, extra = {}) => onSessionEnd(ctx, { client: 'codex', session_id: 'private-session', brainatlas_receipt: candidate, ...extra });
async function tree(dir, prefix = '') {
  const result = {};
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix + e.name, path = join(dir, e.name);
    if (e.isDirectory()) Object.assign(result, await tree(path, rel + '/'));
    else if (e.isFile()) result[rel] = await readFile(path, 'utf8');
  }
  return result;
}

test('manifest declares full/custom and valid entry', async () => {
  const m = JSON.parse(await readFile(new URL('../../../modules/receipts/module.json', import.meta.url)));
  assert.deepEqual(m.profiles, ['full', 'custom']); assert.equal(m.name, 'receipts');
  assert.equal(typeof m.entry, 'string'); await readFile(new URL(`../../../modules/receipts/${m.entry}`, import.meta.url));
});

test('session end queues redacted bounded payload, never reads transcript and leaves vault/home untouched', async () => fixture(async ({ ctx, root, vault, home, stateDir }) => {
  const before = await tree(vault);
  const secret = ['sk', 'test' + 'x'.repeat(24)].join('-');
  const transcript = join(root, 'transcript'); await symlink('/dev/zero', transcript);
  const result = await queue(ctx, { transcript_path: transcript, brainatlas_receipt: { title: `token ${secret}`, summary: `token ${secret}`, suggestedPath: `wiki/summaries/${secret}.md`, sources: [`token ${secret}`] } });
  assert.equal(result.queued, true); assert.equal(result.candidates, 1);
  const stored = await readFile(join(stateDir, 'receipts/queue', `${result.id}.json`), 'utf8');
  assert(!stored.includes(secret)); assert(!JSON.stringify(result).includes(secret)); assert(!stored.includes('private-session')); assert(!stored.includes(transcript));
  assert.deepEqual(await tree(vault), before); assert.deepEqual(await tree(home), {});
  const shown = await showReceipt(ctx, result.id); assert(!JSON.stringify(shown).includes(secret));
  const approved = await approveReceipt(ctx, result.id); assert(!JSON.stringify(approved).includes(secret));
  assert(!JSON.stringify(await tree(vault)).includes(secret)); assert(!JSON.stringify(await tree(stateDir)).includes(secret));
  assert.equal(await onSessionEnd(ctx, { client: 'unknown' }), null);
  const empty = await queue(ctx, { brainatlas_receipt: null }); assert.equal(empty.candidates, 0);
  const many = await queue(ctx, { brainatlas_receipt: Array.from({ length: 25 }, () => ({ title: 'x'.repeat(300), sources: Array(25).fill('s') })) });
  const record = await showReceipt(ctx, many.id); assert.equal(record.candidates.length, 20); assert.equal(record.candidates[0].title.length, 240); assert.equal(record.candidates[0].sources.length, 20);
}));

test('review commands use the specified args, context interface for list, show, approve and reject', async () => fixture(async ({ ctx, vault, stateDir }) => {
  assert.deepEqual(await commands.review(['list'], ctx), []);
  const first = await queue(ctx); assert.equal((await commands.review(['show', first.id], ctx)).id, first.id);
  assert.equal((await commands.review(['list'], ctx)).length, 1);
  await commands.review(['approve', first.id], ctx);
  assert.match(await readFile(join(vault, 'wiki/concepts/cache.md'), 'utf8'), /status: proposed/);
  const second = await queue(ctx); await commands.review(['reject', second.id], ctx);
  assert.deepEqual(await readdir(join(stateDir, 'receipts/queue/rejected')), [`${second.id}.json`]);
  await assert.rejects(commands.review(['show', '../bad'], ctx));
  await assert.rejects(commands.review(['unknown'], ctx));
}));

test('approval writes proposed OKF page, index and log; rejection does not write vault', async () => fixture(async ({ ctx, vault, stateDir }) => {
  const before = await tree(vault); const rejected = await queue(ctx);
  assert.deepEqual(await tree(vault), before); await rejectReceipt(ctx, rejected.id); assert.deepEqual(await tree(vault), before);
  assert.deepEqual(await readdir(join(stateDir, 'receipts/queue/rejected')), [`${rejected.id}.json`]);
  const approved = await queue(ctx); await approveReceipt(ctx, approved.id);
  const page = await readFile(join(vault, 'wiki/concepts/cache.md'), 'utf8');
  assert.match(page, /status: proposed/); assert.match(page, /generated:/); assert.match(page, /sources:/); assert.match(page, /verified:/); assert.match(page, /stale_after:/);
  assert.deepEqual(checkPage({ path: 'wiki/concepts/cache.md', content: page }, { asOf: new Date('2026-11-08') }).filter(x => x.severity === 'error'), []);
  assert.match(await readFile(join(vault, 'wiki/index.md'), 'utf8'), /Cache proposal/); assert.match(await readFile(join(vault, 'wiki/log.md'), 'utf8'), /receipt-approved/);
  await assert.rejects(showReceipt(ctx, approved.id)); await assert.rejects(rejectReceipt(ctx, rejected.id));
}));

test('bad ids, missing and corrupt records fail; list ignores malformed entries', async () => fixture(async ({ ctx, stateDir }) => {
  await queue(ctx); const dir = join(stateDir, 'receipts/queue');
  const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'; await writeFile(join(dir, `${id}.json`), '{bad');
  await writeFile(join(dir, 'garbage.json'), '{}');
  assert.equal((await listReceipts(ctx)).length, 1);
  for (const bad of ['../escape', '', 'a'.repeat(37), 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', id]) {
    await assert.rejects(showReceipt(ctx, bad)); await assert.rejects(approveReceipt(ctx, bad)); await assert.rejects(rejectReceipt(ctx, bad));
  }
}));

test('traversal and symlinked vault destination cannot write outside vault', async () => fixture(async ({ ctx, root, vault }) => {
  const outside = join(root, 'outside'); await mkdir(outside);
  const first = await queue(ctx, { brainatlas_receipt: { ...candidate, suggestedPath: 'wiki/../../outside/escape.md' } });
  await approveReceipt(ctx, first.id); assert.deepEqual(await readdir(outside), []);
  await symlink(outside, join(vault, 'wiki/concepts/link'));
  const second = await queue(ctx, { brainatlas_receipt: { ...candidate, suggestedPath: 'wiki/concepts/link/escape.md' } });
  await assert.rejects(approveReceipt(ctx, second.id)); assert.deepEqual(await readdir(outside), []);
}));

test('symlinked rejected queue cannot move receipt outside state directory', async () => fixture(async ({ ctx, root, stateDir }) => {
  const outside = join(root, 'outside'); await mkdir(outside); const { id } = await queue(ctx);
  await symlink(outside, join(stateDir, 'receipts/queue/rejected'));
  await assert.rejects(rejectReceipt(ctx, id)); assert.deepEqual(await readdir(outside), []);
}));
