// SPDX-License-Identifier: MIT
import { spawn } from 'node:child_process';
import { NotImplementedError, BrainAtlasError } from './errors.mjs';
import * as fsPromises from 'node:fs/promises';
import * as fsSync from 'node:fs';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
export { NotImplementedError, BrainAtlasError };
export async function atomicWriteFile(file, data, options = {}) {
  if (typeof file !== 'string' || data === undefined) throw new NotImplementedError('util.atomicWriteFile');
  const target = resolve(file);
  const temp = options.tempPrefix
    ? join(dirname(target), `${options.tempPrefix}${randomUUID()}`)
    : join(dirname(target), `.${target.split(sep).at(-1)}.${randomUUID()}.tmp`);
  await mkdir(dirname(target), { recursive: true });
  const fsOps = options.fsOps ?? fsPromises;
  try {
    await fsOps.writeFile(temp, data, { mode: options.mode });
    await fsOps.rename(temp, target);
  } catch (error) {
    try {
      await fsOps.unlink(temp);
      // eslint-disable-next-line no-empty
    } catch {}
    throw error;
  }
}
export function atomicWriteFileSync(file, data, options = {}) {
  if (typeof file !== 'string' || data === undefined) throw new NotImplementedError('util.atomicWriteFileSync');
  const target = resolve(file);
  const temp = options.tempPrefix
    ? join(dirname(target), `${options.tempPrefix}${randomUUID()}`)
    : join(dirname(target), `.${target.split(sep).at(-1)}.${randomUUID()}.tmp`);
  fsSync.mkdirSync(dirname(target), { recursive: true });
  const fsOps = options.fsSyncOps ?? fsSync;
  try {
    fsOps.writeFileSync(temp, data, { mode: options.mode });
    fsOps.renameSync(temp, target);
  } catch (error) {
    try {
      fsOps.unlinkSync(temp);
      // eslint-disable-next-line no-empty
    } catch {}
    throw error;
  }
}
export function safeJoin(root, rel) {
  if (typeof root !== 'string' || typeof rel !== 'string') throw new NotImplementedError('util.safeJoin');
  const clean = rel.replace(/\/+$/, '');
  if (
    !clean ||
    isAbsolute(clean) ||
    clean.includes('\\') ||
    clean.includes('\0') ||
    clean.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new BrainAtlasError('E_PATH_ESCAPE', 'Path is invalid.');
  }
  const base = resolve(root);
  const target = resolve(base, clean);
  const from = relative(base, target);
  if (!from || from === '..' || from.startsWith(`..${sep}`) || isAbsolute(from))
    throw new BrainAtlasError('E_PATH_ESCAPE', 'Path is invalid.');
  return target;
}

export async function resolveSafePath(root, rel) {
  let base = resolve(root);
  try {
    base = await realpath(base);
    // eslint-disable-next-line no-empty
  } catch {}
  const target = safeJoin(base, rel);
  const parts = relative(base, target).split(sep);
  let current = base;
  for (let i = 0; i < parts.length; i++) {
    const candidate = join(current, parts[i]);
    try {
      await lstat(candidate);
      let actual;
      try {
        actual = await realpath(candidate);
      } catch {
        throw new BrainAtlasError('E_PATH_ESCAPE', 'Path resolves outside the vault.');
      }
      const from = relative(base, actual);
      if (actual !== base && (from === '..' || from.startsWith(`..${sep}`) || isAbsolute(from)))
        throw new BrainAtlasError('E_PATH_ESCAPE', 'Path resolves outside the vault.');
      current = actual;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      current = candidate;
      for (const rest of parts.slice(i + 1)) current = join(current, rest);
      return current;
    }
  }
  return current;
}
export async function runCommand(cmd, args, options) {
  if (cmd === undefined && args === undefined && options === undefined)
    throw new NotImplementedError('util.runCommand');
  if (
    typeof cmd !== 'string' ||
    !cmd ||
    !Array.isArray(args) ||
    !args.every((arg) => typeof arg === 'string') ||
    !options ||
    typeof options !== 'object'
  ) {
    throw new BrainAtlasError('E_ARGUMENT', 'Command arguments are invalid.');
  }
  const env = options.env;
  const offline = process.env.BRAINATLAS_OFFLINE === '1' || env?.BRAINATLAS_OFFLINE === '1';
  const commandName = cmd.split(/[\\/]/).at(-1);
  const gitRemoteCommand =
    commandName === 'git' && args.some((arg) => ['clone', 'fetch', 'pull', 'push', 'ls-remote'].includes(arg));
  const remoteUrl = (value) => /^(?:https?|ssh|git):\/\//i.test(value) || /^[^/@:\s]+@[^/:\s]+:.+/.test(value);
  const subcommandIndex = gitRemoteCommand
    ? args.findIndex((arg) => ['clone', 'fetch', 'pull', 'push', 'ls-remote'].includes(arg))
    : -1;
  const hasRemote = subcommandIndex >= 0 && args.slice(subcommandIndex + 1).some(remoteUrl);
  if (offline && (commandName === 'curl' || commandName === 'wget' || hasRemote)) {
    throw new BrainAtlasError('E_OFFLINE', 'Network commands are disabled while offline.');
  }
  const timeoutMs = options.timeoutMs;
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0))
    throw new BrainAtlasError('E_ARGUMENT', 'Command timeout is invalid.');
  return await new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let child;
    try {
      child = spawn(cmd, args, { cwd: options.cwd, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (cause) {
      reject(cause);
      return;
    }
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(value);
    };
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            child.kill('SIGTERM');
            const killTimer = setTimeout(() => {
              if (child.exitCode === null) child.kill('SIGKILL');
            }, 250);
            killTimer.unref?.();
          }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.stdin.on('error', () => {});
    child.on('error', (error) => finish(reject, error));
    child.on('close', (code) => finish(resolve, { code: timedOut ? 124 : (code ?? 1), stdout, stderr }));
    if (options.input === undefined) child.stdin.end();
    else child.stdin.end(options.input);
  });
}
