// SPDX-License-Identifier: MIT
import { link, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

export const LOCK_FILE_NAME = '.brainatlas-write.lock';
export const LOCK_STALE_MS = 30_000;
export const LOCK_WAIT_MS = 5_000;
const RETRY_MS = 25;

function busyError() {
  const error = /** @type {Error & {code:string}} */ (new Error('The Wiki write lock is busy.'));
  error.code = 'E_BUSY';
  return error;
}

function parseLock(text) {
  try {
    const value = JSON.parse(text);
    return value !== null && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function reclaimIfStale(path, staleMs) {
  let text, info, recorded, dead;
  try {
    const st = await stat(path);
    text = await readFile(path, 'utf8');
    info = parseLock(text);
    recorded = Number.isFinite(info.time) ? info.time : st.mtimeMs;
    dead = Number.isInteger(info.pid) && info.pid > 0 && !pidAlive(info.pid);
  } catch (error) {
    return error?.code === 'ENOENT';
  }
  if (!dead && Date.now() - recorded <= staleMs) return false;
  const aside = `${path}.${randomUUID()}.stale`;
  try {
    await rename(path, aside);
  } catch (error) {
    return error?.code === 'ENOENT';
  }
  const moved = await readFile(aside, 'utf8').catch(() => null);
  if (moved !== text) {
    await link(aside, path).catch(() => {});
    await unlink(aside).catch(() => {});
    return false;
  }
  await unlink(aside).catch(() => {});
  return true;
}

export async function acquireLock(path, { waitMs = LOCK_WAIT_MS, staleMs = LOCK_STALE_MS, retryMs = RETRY_MS } = {}) {
  const token = randomUUID();
  const body = `${JSON.stringify({ pid: process.pid, time: Date.now(), token })}\n`;
  const deadline = Date.now() + waitMs;
  for (;;) {
    let handle;
    try {
      handle = await open(path, 'wx');
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (await reclaimIfStale(path, staleMs)) continue;
      if (Date.now() >= deadline) throw busyError();
      await sleep(retryMs);
      continue;
    }
    try {
      await handle.writeFile(body);
    } catch (error) {
      await handle.close().catch(() => {});
      await unlink(path).catch(() => {});
      throw error;
    }
    await handle.close();
    return token;
  }
}

export async function releaseLock(path, token) {
  try {
    const text = await readFile(path, 'utf8');
    if (parseLock(text).token === token) await unlink(path);
    // eslint-disable-next-line no-empty
  } catch {}
}

export async function withLock(path, work, options) {
  const token = await acquireLock(path, options);
  try {
    return await work();
  } finally {
    await releaseLock(path, token);
  }
}
