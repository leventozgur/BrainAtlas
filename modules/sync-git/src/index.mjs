// SPDX-License-Identifier: MIT
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { BrainAtlasError, runCommand as coreRunCommand } from '../../../packages/core/src/util/index.mjs';
import { mergeCanonicalPath } from '../../sync-engine/src/merge.mjs';
import { ConflictError, SyncTransportError, validateTransportPath } from '../../sync-engine/src/transport.mjs';

const RETRIES = 3;
const COMMAND_TIMEOUT_MS = 120_000;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const missing = (error) => error?.code === 'ENOENT';

function transportPath(path) {
  validateTransportPath(path);
  if (path.split('/').includes('.git')) throw new SyncTransportError('E_INVALID_PATH');
  if (/[\u0001-\u001f\u007f]/.test(path)) throw new SyncTransportError('E_INVALID_PATH');
  return path;
}

function errorCodeFrom(stderr, code) {
  const message = String(stderr ?? '').toLowerCase();
  if (/authentication failed|permission denied|could not read username|access denied|publickey/.test(message)) return 'E_AUTH';
  if (/quota|no space left/.test(message)) return 'E_QUOTA';
  if (/non-fast-forward|fetch first|not possible to fast-forward|would be overwritten/.test(message)) return 'E_CONFLICT';
  if (code === 'E_OFFLINE') return 'E_OFFLINE';
  return 'E_NETWORK';
}

function isRemoteUrl(value) {
  return /^(?:https?|ssh|git):\/\//i.test(value) || /^[^/@:\s]+@[^/:\s]+:.+/.test(value);
}

function conflictCopyPath(path, host, timestamp, index = 0) {
  const directory = dirname(path) === '.' ? '' : `${dirname(path)}/`;
  const file = basename(path);
  const extension = file.endsWith('.md') ? '.md' : '';
  const stem = extension ? file.slice(0, -extension.length) : file;
  const suffix = index ? `-${index}` : '';
  return `${directory}${stem}.conflict-${host}-${timestamp}${suffix}${extension}`;
}

function isoStamp(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function strictUtf8(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return null; }
}

/**
 * A Git backed object transport. It owns only `stateDir/sync/git`; it never
 * opens or modifies the vault's Git metadata.
 * @param {{stateDir:string,remote:string,env?:Record<string,string|undefined>,runCommand?:Function,now?:()=>Date,hostId?:string}} options
 */
export function createGitTransport({ stateDir, remote, env = process.env, runCommand = coreRunCommand, now = () => new Date(), hostId = 'host' } = {}) {
  if (typeof stateDir !== 'string' || !stateDir) throw new BrainAtlasError('E_MODULE_CONTEXT', 'Git transport state is incomplete.');
  if (typeof runCommand !== 'function') throw new BrainAtlasError('E_ARGUMENT', 'Git command runner is invalid.');
  const syncDir = join(resolve(stateDir), 'sync');
  const repoDir = join(syncDir, 'git');
  const host = String(hostId).toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 32) || 'host';
  let ready = false;
  let initialization;

  function configuredRemote() {
    if (typeof remote !== 'string' || !remote.trim()) throw new BrainAtlasError('E_NOT_FOUND', 'Git remote is not configured.');
    return remote.trim();
  }

  function assertOnline() {
    const address = configuredRemote();
    if ((env?.BRAINATLAS_OFFLINE === '1' || process.env.BRAINATLAS_OFFLINE === '1') && isRemoteUrl(address)) {
      throw new BrainAtlasError('E_OFFLINE', 'Network commands are disabled while offline.');
    }
  }

  function commandEnv() {
    return {
      ...process.env,
      ...(env ?? {}),
      GIT_TERMINAL_PROMPT: '0',
    };
  }

  function gitArgs(args) {
    return ['-c', 'user.name=Sync Worker', '-c', 'user.email=local', ...args];
  }

  async function execute(args, { cwd = repoDir, allowFailure = false } = {}) {
    let result;
    try {
      result = await runCommand('git', gitArgs(args), { cwd, env: commandEnv(), timeoutMs: COMMAND_TIMEOUT_MS });
    } catch (cause) {
      if (cause?.code === 'E_OFFLINE') throw cause;
      throw new SyncTransportError(errorCodeFrom(cause?.message, cause?.code));
    }
    if (!allowFailure && result.code !== 0) throw new SyncTransportError(errorCodeFrom(result.stderr, result.code));
    return result;
  }

  async function ensureDirectory(path) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new SyncTransportError('E_INVALID_PATH');
  }

  async function ensureReady() {
    if (ready) return;
    if (initialization) return initialization;
    initialization = (async () => {
      assertOnline();
      await ensureDirectory(syncDir);
      let exists = false;
      try {
        const info = await lstat(repoDir);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new SyncTransportError('E_INVALID_PATH');
        exists = true;
      } catch (error) { if (!missing(error)) throw error; }

      if (!exists) {
        const result = await runCommand('git', gitArgs(['clone', '--', configuredRemote(), repoDir]), {
          cwd: syncDir, env: commandEnv(), timeoutMs: COMMAND_TIMEOUT_MS,
        }).catch((cause) => {
          if (cause?.code === 'E_OFFLINE') throw cause;
          throw new SyncTransportError(errorCodeFrom(cause?.message, cause?.code));
        });
        if (result.code !== 0) {
          await rm(repoDir, { recursive: true, force: true }).catch(() => {});
          throw new SyncTransportError(errorCodeFrom(result.stderr, result.code));
        }
      }

      const top = await execute(['rev-parse', '--show-toplevel'], { allowFailure: true });
      if (top.code !== 0 || await realpath(top.stdout.trim()) !== await realpath(repoDir)) throw new SyncTransportError('E_DEGRADED');
      const url = await execute(['remote', 'get-url', 'origin'], { allowFailure: true });
      if (url.code !== 0) throw new SyncTransportError('E_DEGRADED');
      if (url.stdout.trim() !== configuredRemote()) {
        const changed = await execute(['remote', 'set-url', 'origin', configuredRemote()], { allowFailure: true });
        if (changed.code !== 0) throw new SyncTransportError('E_DEGRADED');
      }
      ready = true;
    })();
    try { await initialization; }
    finally { initialization = undefined; }
  }

  async function head() {
    const result = await execute(['rev-parse', '--verify', 'HEAD'], { allowFailure: true });
    return result.code === 0 ? result.stdout.trim() : null;
  }

  async function upstream() {
    const result = await execute(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { allowFailure: true });
    return result.code === 0 ? result.stdout.trim() : null;
  }

  async function hasUnpushedCommits() {
    if (!await head()) return false;
    const tracked = await upstream();
    if (!tracked) return true;
    const result = await execute(['rev-list', '--count', `${tracked}..HEAD`], { allowFailure: true });
    return result.code === 0 && Number(result.stdout.trim()) > 0;
  }

  async function pullFailure() {
    const unmerged = await execute(['diff', '--name-only', '--diff-filter=U', '-z'], { allowFailure: true });
    const paths = unmerged.code === 0 ? unmerged.stdout.split('\0').filter(Boolean) : [];
    if (!paths.length) return false;
    const aborted = await execute(['rebase', '--abort'], { allowFailure: true });
    if (aborted.code !== 0) throw new SyncTransportError('E_DEGRADED');
    await resolveRebaseConflict();
    return true;
  }

  async function gitPull() {
    if (!await head()) return false;
    if (!await upstream()) return false;
    const result = await execute(['pull', '--rebase'], { allowFailure: true });
    if (result.code === 0) return false;
    if (await pullFailure()) return true;
    throw new SyncTransportError(errorCodeFrom(result.stderr, result.code));
  }

  async function changedPaths(base, localHead) {
    const result = await execute(['diff', '--no-renames', '--name-only', '-z', base, localHead], { allowFailure: true });
    if (result.code !== 0) throw new SyncTransportError('E_DEGRADED');
    return [...new Set(result.stdout.split('\0').filter(Boolean))].map(transportPath).sort();
  }

  async function ensureParents(path) {
    const parts = path.split('/');
    let current = repoDir;
    for (const part of parts.slice(0, -1)) {
      current = join(current, part);
      try {
        const info = await lstat(current);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new SyncTransportError('E_INVALID_PATH');
      } catch (error) {
        if (!missing(error)) throw error;
        await mkdir(current, { mode: 0o700 });
      }
    }
    const target = join(repoDir, ...parts);
    try {
      const info = await lstat(target);
      if (!info.isFile() || info.isSymbolicLink()) throw new SyncTransportError('E_INVALID_PATH');
    } catch (error) { if (!missing(error)) throw error; }
    const from = relative(repoDir, resolve(target));
    if (from === '..' || from.startsWith(`..${sep}`) || from === '') throw new SyncTransportError('E_INVALID_PATH');
    return target;
  }

  async function writeObject(path, bytes) {
    const target = await ensureParents(path);
    await writeFile(target, bytes, { mode: 0o600 });
  }

  async function readObject(path) {
    return readSnapshotObject(repoDir, path);
  }

  async function addSnapshot(revision) {
    const directory = join(syncDir, `git-snapshot-${randomUUID()}`);
    const result = await execute(['worktree', 'add', '--detach', directory, revision], { allowFailure: true });
    if (result.code !== 0) throw new SyncTransportError('E_DEGRADED');
    return directory;
  }

  async function removeSnapshot(directory) {
    await execute(['worktree', 'remove', '--force', directory], { allowFailure: true });
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }

  async function readSnapshotObject(snapshot, path) {
    let current = snapshot;
    const parts = path.split('/');
    for (const part of parts.slice(0, -1)) {
      current = join(current, part);
      try {
        const info = await lstat(current);
        if (!info.isDirectory() || info.isSymbolicLink()) return null;
      } catch (error) { if (missing(error)) return null; throw error; }
    }
    const target = join(current, parts.at(-1));
    try {
      const info = await lstat(target);
      if (!info.isFile() || info.isSymbolicLink()) return null;
      return await readFile(target);
    } catch (error) { if (missing(error)) return null; throw error; }
  }

  async function listFiles(directory = repoDir, prefix = '') {
    const rows = [];
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === '.git') continue;
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) rows.push(...await listFiles(join(directory, entry.name), relativePath));
      else if (entry.isFile()) rows.push(relativePath);
    }
    return rows;
  }

  async function stageAndCommit(message) {
    await execute(['add', '--all', '--', '.']);
    const status = await execute(['status', '--porcelain=v1', '--untracked-files=all']);
    if (!status.stdout.trim()) return false;
    const result = await execute(['commit', '-m', message], { allowFailure: true });
    if (result.code !== 0) throw new SyncTransportError(errorCodeFrom(result.stderr, result.code));
    return true;
  }

  async function pushOnce() {
    const branch = await execute(['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFailure: true });
    const targetBranch = branch.code === 0 && branch.stdout.trim() ? branch.stdout.trim() : 'main';
    const result = await execute(['push', '--set-upstream', 'origin', `HEAD:refs/heads/${targetBranch}`], { allowFailure: true });
    return result;
  }

  async function pushWithRetries() {
    for (let attempt = 0; attempt < RETRIES; attempt += 1) {
      assertOnline();
      const pushed = await pushOnce();
      if (pushed.code === 0) return;
      if (attempt === RETRIES - 1) throw new SyncTransportError(errorCodeFrom(pushed.stderr, pushed.code));
      const hadResolution = await gitPull();
      if (hadResolution) continue;
    }
    throw new SyncTransportError('E_NETWORK');
  }

  async function resolveRebaseConflict() {
    const localHead = await head();
    const fetched = await execute(['rev-parse', '--verify', 'FETCH_HEAD'], { allowFailure: true });
    const remoteHead = fetched.code === 0 ? fetched.stdout.trim() : null;
    if (!localHead || !remoteHead) throw new SyncTransportError('E_DEGRADED');
    const baseResult = await execute(['merge-base', localHead, remoteHead], { allowFailure: true });
    const base = baseResult.code === 0 ? baseResult.stdout.trim() : null;
    if (!base) throw new SyncTransportError('E_DEGRADED');

    const paths = await changedPaths(base, localHead);
    const plans = [];
    const stamp = isoStamp(now());
    const snapshots = [];
    try {
      snapshots.push(await addSnapshot(base));
      snapshots.push(await addSnapshot(localHead));
      snapshots.push(await addSnapshot(remoteHead));
      for (const path of paths) {
        const [baseBytes, localBytes, remoteBytes] = await Promise.all(snapshots.map((snapshot) => readSnapshotObject(snapshot, path)));
        const remoteChanged = (baseBytes === null) !== (remoteBytes === null)
          || (baseBytes && remoteBytes && !baseBytes.equals(remoteBytes));
        let content = localBytes;
        let conflictContent = null;
        if (remoteChanged && remoteBytes && localBytes && !localBytes.equals(remoteBytes)) {
          const baseText = baseBytes === null ? '' : strictUtf8(baseBytes);
          const localText = strictUtf8(localBytes);
          const remoteText = strictUtf8(remoteBytes);
          if ((path === 'wiki/index.md' || path === 'wiki/log.md') && baseText !== null && localText !== null && remoteText !== null) {
            const merged = mergeCanonicalPath(path, baseText, localText, remoteText);
            if (!merged.conflicts.length && merged.content !== null) content = Buffer.from(merged.content);
            else conflictContent = remoteBytes;
          } else conflictContent = remoteBytes;
        } else if (remoteChanged && !localBytes && remoteBytes) {
          // A local delete racing a remote edit leaves the remote object intact.
          content = remoteBytes;
        }
        plans.push({ path, content, conflictContent });
      }
    } finally {
      for (const snapshot of snapshots.reverse()) await removeSnapshot(snapshot);
    }

    const merged = await execute(['merge', '--no-commit', '--no-ff', remoteHead], { allowFailure: true });
    if (merged.code !== 0) {
      const unresolved = await execute(['diff', '--name-only', '--diff-filter=U', '-z'], { allowFailure: true });
      if (unresolved.code !== 0 || !unresolved.stdout.split('\0').filter(Boolean).length) {
        await execute(['merge', '--abort'], { allowFailure: true });
        throw new SyncTransportError('E_DEGRADED');
      }
    }
    for (const plan of plans) {
      if (plan.content === null) {
        const removed = await execute(['rm', '--force', '--ignore-unmatch', '--', plan.path], { allowFailure: true });
        if (removed.code !== 0) throw new SyncTransportError('E_DEGRADED');
      } else await writeObject(plan.path, plan.content);
      if (plan.conflictContent) {
        let copyPath;
        for (let index = 0; index < 100; index += 1) {
          const candidate = conflictCopyPath(plan.path, host, stamp, index);
          if (!(await readObject(candidate))) { copyPath = candidate; break; }
        }
        if (!copyPath) throw new SyncTransportError('E_DEGRADED');
        await writeObject(copyPath, plan.conflictContent);
      }
    }
    await stageAndCommit('sync: reconcile concurrent updates');
  }

  async function pull() {
    await ensureReady();
    assertOnline();
    const resolved = await gitPull();
    if (resolved || await hasUnpushedCommits()) await pushWithRetries();
  }

  async function commitAndPush(message = 'sync: update objects') {
    await ensureReady();
    const cleanMessage = typeof message === 'string' && message.trim()
      ? message.replace(/[\r\n\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 160)
      : 'sync: update objects';
    await stageAndCommit(cleanMessage);
    await pushWithRetries();
  }

  return Object.freeze({
    capabilities: Object.freeze({ cas: true, mode: 'git' }),
    async list(prefix = '') {
      if (prefix && typeof prefix !== 'string') throw new SyncTransportError('E_INVALID_PATH');
      if (prefix) transportPath(prefix.endsWith('/') ? prefix.slice(0, -1) : prefix);
      await pull();
      const paths = await listFiles();
      return Promise.all(paths.filter((path) => path.startsWith(prefix)).sort().map(async (path) => {
        transportPath(path);
        const bytes = await readObject(path);
        return bytes ? { path, rev: sha256(bytes), size: bytes.byteLength } : null;
      })).then((rows) => rows.filter(Boolean));
    },
    async get(path) {
      transportPath(path);
      await ensureReady();
      const bytes = await readObject(path);
      return bytes ? { bytes: Uint8Array.from(bytes), rev: sha256(bytes) } : null;
    },
    async put(path, bytes, options = {}) {
      transportPath(path);
      if (!(bytes instanceof Uint8Array)) throw new TypeError('Transport bytes must be a Uint8Array.');
      if (!options || typeof options !== 'object' || Array.isArray(options)) throw new BrainAtlasError('E_ARGUMENT', 'Git put options are invalid.');
      await ensureReady();
      if (options.ifAbsent === true && options.ifRev !== undefined) throw new ConflictError();
      const current = await readObject(path);
      if (options.ifAbsent && current) throw new ConflictError();
      if (options.ifRev !== undefined && (!current || sha256(current) !== options.ifRev)) throw new ConflictError();
      if (!options.ifAbsent && options.ifRev === undefined && current) throw new ConflictError();
      if (!current || !current.equals(Buffer.from(bytes))) {
        await writeObject(path, Buffer.from(bytes));
        await commitAndPush('sync: update objects');
      }
      const stored = await readObject(path);
      if (!stored) throw new SyncTransportError('E_DEGRADED');
      return { rev: sha256(stored) };
    },
    async delete(path, options = {}) {
      transportPath(path);
      if (!options || typeof options !== 'object' || Array.isArray(options)) throw new BrainAtlasError('E_ARGUMENT', 'Git delete options are invalid.');
      await ensureReady();
      const current = await readObject(path);
      if (!current) throw new SyncTransportError('E_NOT_FOUND');
      if (!options.ifRev || sha256(current) !== options.ifRev) throw new ConflictError();
      const removed = await execute(['rm', '--force', '--ignore-unmatch', '--', path], { allowFailure: true });
      if (removed.code !== 0) throw new SyncTransportError('E_DEGRADED');
      await commitAndPush('sync: delete object');
    },
    pull,
    commitAndPush,
    async status() {
      if (!ready) {
        try { await lstat(repoDir); }
        catch (error) { if (missing(error)) return { mode: 'git', initialized: false, clean: true, ahead: 0, behind: 0 }; throw error; }
      }
      await ensureReady();
      const status = await execute(['status', '--porcelain=v1', '--untracked-files=all']);
      const headId = await head();
      let ahead = 0, behind = 0;
      if (headId) {
        const counts = await execute(['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'], { allowFailure: true });
        if (counts.code === 0) [ahead, behind] = counts.stdout.trim().split(/\s+/).map((value) => Number(value) || 0);
      }
      return { mode: 'git', initialized: true, clean: status.stdout.length === 0, ahead, behind };
    },
  });
}

export async function activate(ctx) {
  if (!ctx || !ctx.config || !ctx.paths || typeof ctx.paths.stateDir !== 'string') {
    throw new BrainAtlasError('E_MODULE_CONTEXT', 'Git sync module context is incomplete.');
  }
  if (ctx.config.sync?.transport !== 'git') return;
  if (ctx.transport) return;
  ctx.transport = createGitTransport({
    stateDir: ctx.paths.stateDir,
    remote: ctx.config.sync?.options?.remote,
    env: ctx.env ?? process.env,
    hostId: ctx.env?.BRAINATLAS_HOST_ID,
  });
}

export const commands = Object.freeze({});
