// SPDX-License-Identifier: MIT
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approveReceipt, commands, listReceipts, onSessionEnd, rejectReceipt, showReceipt } from '../../../modules/receipts/src/index.mjs';
import { initVault } from '../../../packages/core/src/vault/index.mjs';

async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), 'receipts-test-'));
  try {
    const stateDir = join(root, 'state'); const vault = join(root, 'vault');
    await mkdir(stateDir); await initVault(vault);
    const ctx = { paths: { stateDir }, config: { vault: { path: vault } }, env: { HOME: join(root, 'home') }, now: new Date('2026-11-08T10:00:00.000Z') };
    await fn({ ctx, stateDir, vault, root });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('session end queues only the optional event field and stores a hashed session id', async () => fixture(async ({ ctx, stateDir }) => {
  const result = await onSessionEnd(ctx, { client: 'codex', session_id: 'session-private-id', transcript_path: '/home/you/private.md',
    brainatlas_receipt: { title: 'Safer cache', summary: 'Use bounded cache.', suggestedPath: 'wiki/concepts/cache.md', sources: ['src/cache.mjs:12'] } });
  assert.equal(result.queued, true); assert.equal(result.candidates, 1);
  const [name] = await readdir(join(stateDir, 'receipts/queue'));
  const record = JSON.parse(await readFile(join(stateDir, 'receipts/queue', name), 'utf8'));
  assert.equal(record.client, 'codex'); assert.equal(record.session.length, 16); assert.notEqual(record.session, 'session-private-id');
  assert.deepEqual(record.candidates[0], { title: 'Safer cache', summary: 'Use bounded cache.', suggestedPath: 'wiki/concepts/cache.md', sources: ['src/cache.mjs:12'] });
  assert.doesNotMatch(JSON.stringify(record), /transcript_path|private\.md/);
  assert.equal((await stat(join(stateDir, 'receipts/queue', name))).mode & 0o077, 0);
}));

test('session end redacts candidate text, handles empty candidates, and ignores unknown clients', async () => fixture(async ({ ctx }) => {
  const ignored = await onSessionEnd(ctx, { client: 'unknown', brainatlas_receipt: { title: 'unused' } });
  assert.equal(ignored, null);
  await onSessionEnd(ctx, { client: 'claude', sessionId: 'another-session' });
  const result = await onSessionEnd(ctx, { client: 'kiro', session_id: 'redact-session', brainatlas_receipt: { title: 'API token: abcdefghijklmnopqrstuvwxyz123456', summary: 'Keep ordinary context.' } });
  const rows = await listReceipts(ctx);
  assert.equal(rows.length, 2);
  assert.match(rows.find((row) => row.id === result.id).candidates[0].title, /^API token: \[REDACTED:[a-z-]+\]$/);
  assert.equal(rows.find((row) => row.candidates.length === 0).candidates.length, 0);
}));

test('review list/show/reject operate on queue and move rejected records out', async () => fixture(async ({ ctx }) => {
  const { id } = await onSessionEnd(ctx, { client: 'claude', session_id: 'review-session', brainatlas_receipt: { title: 'Review me', summary: 'Proposal text.' } });
  assert.equal((await commands.review(['list'], ctx)).length, 1);
  assert.equal((await commands.review(['show', id], ctx)).id, id);
  assert.deepEqual(await rejectReceipt(ctx, id), { id, rejected: true });
  assert.deepEqual(await listReceipts(ctx), []);
  assert.deepEqual(await readdir(join(ctx.paths.stateDir, 'receipts/queue/rejected')), [`${id}.json`]);
  await assert.rejects(showReceipt(ctx, id), { code: 'E_RECEIPT_NOT_FOUND' });
}));

test('review rejects a symlinked rejected directory without moving the receipt outside state', async () => fixture(async ({ ctx, root, stateDir }) => {
  const outside = join(root, 'outside'); await mkdir(outside);
  const { id } = await onSessionEnd(ctx, { client: 'claude', brainatlas_receipt: { title: 'Keep in state' } });
  await symlink(outside, join(stateDir, 'receipts/queue/rejected'));
  await assert.rejects(rejectReceipt(ctx, id), { code: 'E_RECEIPT_STATE_UNSAFE' });
  assert.deepEqual(await readdir(outside), []);
  assert.equal((await listReceipts(ctx)).length, 1);
}));

test('approval writes a proposed OKF page, index and log only after explicit approval', async () => fixture(async ({ ctx, vault }) => {
  const { id } = await onSessionEnd(ctx, { client: 'codex', session_id: 'approve-session', brainatlas_receipt: {
    title: 'Cache design', summary: 'Use a small bounded cache.', suggestedPath: 'wiki/concepts/cache-design.md', sources: ['src/cache.mjs:7'],
  } });
  await assert.rejects(readFile(join(vault, 'wiki/concepts/cache-design.md')));
  const result = await approveReceipt(ctx, id);
  assert.deepEqual(result, { id, approved: ['wiki/concepts/cache-design.md'] });
  const page = await readFile(join(vault, 'wiki/concepts/cache-design.md'), 'utf8');
  assert.match(page, /status: proposed/); assert.match(page, /generated: "2026-11-08"/); assert.match(page, /src\/cache\.mjs:7/);
  assert.match(await readFile(join(vault, 'wiki/index.md'), 'utf8'), /Cache design/);
  assert.match(await readFile(join(vault, 'wiki/log.md'), 'utf8'), /receipt-approved/);
  assert.deepEqual(await listReceipts(ctx), []);
  assert.deepEqual(await readdir(join(ctx.paths.stateDir, 'receipts/queue/approved')), [`${id}.json`]);
}));

test('unsafe suggested page paths fall back to a generated vault path', async () => fixture(async ({ ctx, vault }) => {
  const { id } = await onSessionEnd(ctx, { client: 'claude', brainatlas_receipt: { title: 'Fallback page', summary: 'safe', suggestedPath: 'wiki/../../outside.md' } });
  const result = await approveReceipt(ctx, id);
  assert.deepEqual(result.approved, ['wiki/summaries/fallback-page.md']);
  await assert.rejects(readFile(join(vault, 'outside.md')));
}));
