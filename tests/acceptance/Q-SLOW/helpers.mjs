// SPDX-License-Identifier: MIT
// Shared helpers for the Q-SLOW blind acceptance tests. Deterministic, offline, temp-dir only.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const makeSecret = () => ['sk', 'test' + 'x'.repeat(24)].join('-');

export async function tempRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'q-slow-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

/** A wiki directory and a separate state directory inside one temp root. */
export async function workspace(t, files = {}) {
  const root = await tempRoot(t);
  const wiki = join(root, 'vault', 'wiki');
  const stateDir = join(root, 'state');
  await mkdir(wiki, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    await mkdir(join(wiki, name, '..'), { recursive: true });
    await writeFile(join(wiki, name), body);
  }
  return { root, vault: join(root, 'vault'), wiki, stateDir, semanticDir: join(stateDir, 'semantic') };
}

/** One page with `count` heading sections; each section is exactly one chunk. */
export function sectionPage(title, count, tag = 'x') {
  let text = `# ${title}\n`;
  for (let i = 0; i < count; i++) text += `\n## Section ${i}\nbody ${tag} number ${i} lorem ipsum\n`;
  return text;
}

export function vecFor(text, dims = 3) {
  const digest = createHash('sha256').update(text).digest();
  return Array.from({ length: dims }, (_, i) => digest[i] / 255);
}

export function fakeClock(start = 1_700_000_000_000) {
  const clock = { time: start, now: () => clock.time, advance: ms => { clock.time += ms; } };
  return clock;
}

/**
 * Deterministic fake provider. `durations[i]` is the simulated duration (ms) of call i+1
 * (the last value repeats). The shared fake clock is advanced by that amount.
 */
export function fakeProvider({ dims = 3, fingerprint = 'fp-a', id = 'fake:model', clock = fakeClock(), durations = [0],
  failOnCall = null, onCall = null, preprocessVersion, vector = vecFor } = {}) {
  const calls = [];
  const provider = {
    id, dims, fingerprint, calls, clock,
    ...(preprocessVersion === undefined ? {} : { preprocessVersion }),
    async embedDocuments(texts) {
      calls.push([...texts]);
      const index = calls.length;
      if (onCall) await onCall(index, texts);
      if (failOnCall === index) throw Object.assign(new Error('fixture provider failure'), { code: 'E_FIXTURE' });
      clock.advance(durations[Math.min(index - 1, durations.length - 1)]);
      return texts.map(text => vector(text, dims));
    },
    async embedQuery(text) { return vector(text, dims); },
    get sizes() { return calls.map(call => call.length); },
    get texts() { return calls.flat(); },
  };
  return provider;
}

export async function readJson(file) { return JSON.parse(await readFile(file, 'utf8')); }
export async function readJsonOrNull(file) {
  try { return await readJson(file); } catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}
export async function exists(file) { try { await stat(file); return true; } catch (error) { if (error?.code === 'ENOENT') return false; throw error; } }

/** Recursive listing with file content hashes; used to prove "no write happened". */
export async function snapshot(root, prefix = '') {
  const result = {};
  let entries;
  try { entries = await readdir(join(root, prefix), { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return result; throw error; }
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) { result[`${rel}/`] = 'dir'; Object.assign(result, await snapshot(root, rel)); }
    else result[rel] = sha256(await readFile(join(root, rel)));
  }
  return result;
}

/** Index text with the volatile createdAt neutralised. */
export function normalizedIndexText(text) {
  assert.equal(text.endsWith('\n'), true);
  return text.replace(/"createdAt":"[^"]*"/u, '"createdAt":"<redacted>"');
}

/**
 * Drive a promise that depends on mocked setTimeout/Date by ticking virtual time while real I/O proceeds.
 */
export async function drive(t, promise, stepMs = 500, max = 5000) {
  let settled = false;
  const wrapped = promise.then(value => { settled = true; return value; }, error => { settled = true; throw error; });
  wrapped.catch(() => {});
  for (let i = 0; i < max && !settled; i++) {
    await new Promise(resolve => setImmediate(resolve));
    t.mock.timers.tick(stepMs);
  }
  assert.equal(settled, true, 'driven promise did not settle');
  return wrapped;
}
