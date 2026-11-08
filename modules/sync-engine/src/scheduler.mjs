// SPDX-License-Identifier: MIT
import { createHash, randomUUID } from 'node:crypto';
import { O_APPEND, O_CREAT, O_EXCL, O_NOFOLLOW, O_WRONLY } from 'node:constants';
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { runCommand as defaultRunCommand } from '@brainatlas/core';
import { BrainAtlasError } from '../../../packages/core/src/util/errors.mjs';
import { SyncTransportError } from './transport.mjs';

const xml = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const schedulerStatePath = (stateDir) => join(stateDir, 'sync', 'scheduler.json');
const schedulerLogPath = (stateDir) => join(stateDir, 'sync', 'scheduler.log');
const commandError = () => new BrainAtlasError('E_SCHEDULER_COMMAND', 'Scheduler command failed.');
const schedulerStopError = () => new BrainAtlasError('E_SCHEDULER_COMMAND', 'Could not stop the sync scheduler.');
const pathEscape = () => new BrainAtlasError('E_PATH_ESCAPE', 'Scheduler paths must resolve within HOME.');

function isWithin(root, path) {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function realpathWithMissingTail(path) {
  let current = resolve(path);
  const tail = [];
  while (true) {
    try {
      const actual = await realpath(current);
      return resolve(actual, ...tail);
    } catch (cause) {
      if (!['ENOENT', 'ENOTDIR'].includes(cause?.code)) throw pathEscape();
      let info;
      try { info = await lstat(current); }
      catch (statError) { if (statError?.code !== 'ENOENT' && statError?.code !== 'ENOTDIR') throw pathEscape(); }
      // A dangling symlink cannot be safely approximated by appending a missing tail.
      if (info?.isSymbolicLink()) throw pathEscape();
      const parent = dirname(current);
      if (parent === current) throw pathEscape();
      tail.unshift(basename(current));
      current = parent;
    }
  }
}

async function assertSchedulerPaths(ctx, paths, files) {
  const allowOutside = ctx.env?.BRAINATLAS_ALLOW_SYMLINKED_ROOT === '1';
  let home;
  try { home = await realpath(paths.home); }
  catch { throw pathEscape(); }
  for (const file of files) {
    let info;
    try { info = await lstat(file); }
    catch (cause) { if (cause?.code !== 'ENOENT') throw pathEscape(); }
    // Never replace or remove a symlink at the managed file path, even with opt-in.
    if (info?.isSymbolicLink()) throw pathEscape();
    const directoryPath = await realpathWithMissingTail(dirname(file));
    const filePath = info ? await realpathWithMissingTail(file) : resolve(directoryPath, basename(file));
    if (!allowOutside && (!isWithin(home, directoryPath) || !isWithin(home, filePath))) throw pathEscape();
  }
}

function unitEscape(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll(' ', '\\x20').replaceAll('"', '\\"');
}

/** Build user-level scheduler files without touching the filesystem or host scheduler. */
export function planScheduler({ platform, paths, intervalMin = 30 } = {}) {
  if (!['darwin', 'linux'].includes(platform) || !paths || typeof paths.binPath !== 'string' || typeof paths.stateDir !== 'string'
      || !Number.isSafeInteger(intervalMin) || intervalMin < 1 || intervalMin > 1440) throw new SyncTransportError('E_STATE_INVALID');
  const logPath = schedulerLogPath(paths.stateDir);
  let files;
  if (platform === 'darwin') {
    const target = join(paths.launchAgentsDir ?? join(paths.home ?? paths.stateDir, 'Library', 'LaunchAgents'), 'org.brainatlas.sync.plist');
    const contents = `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>\n<key>Label</key><string>org.brainatlas.sync</string>\n<key>ProgramArguments</key><array><string>${xml(paths.binPath)}</string><string>sync</string><string>run</string></array>\n<key>StartInterval</key><integer>${intervalMin * 60}</integer>\n<key>RunAtLoad</key><true/>\n<key>StandardOutPath</key><string>${xml(logPath)}</string>\n<key>StandardErrorPath</key><string>${xml(logPath)}</string>\n</dict></plist>\n`;
    files = [{ path: target, contents }];
  } else {
    const root = paths.systemdUserDir ?? join(paths.configDir ?? paths.home ?? paths.stateDir, 'systemd', 'user');
    const command = `"${paths.binPath.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}" sync run`;
    files = [
      { path: join(root, 'brainatlas-sync.service'), contents: `[Unit]\nDescription=BrainAtlas sync\n\n[Service]\nType=oneshot\nExecStart=${command}\nStandardOutput=append:${unitEscape(logPath)}\nStandardError=append:${unitEscape(logPath)}\n` },
      { path: join(root, 'brainatlas-sync.timer'), contents: `[Unit]\nDescription=Run BrainAtlas sync periodically\n\n[Timer]\nOnBootSec=1min\nOnUnitActiveSec=${intervalMin}min\nPersistent=true\nUnit=brainatlas-sync.service\n\n[Install]\nWantedBy=timers.target\n` },
    ];
  }
  const uninstall = files.map((file) => file.path);
  const text = `${files.map((file) => `# ${basename(file.path)}\n${file.contents}`).join('\n')}\n# scheduler log\n${logPath} (0600)\n`;
  return { platform, intervalMin, logPath, text, files, uninstall, installManifest: { files: [...uninstall] } };
}

export function planSchedulerUninstall({ platform, paths } = {}) {
  const plan = planScheduler({ platform, paths });
  return { platform, files: plan.uninstall, text: `Remove these scheduler files:\n${plan.uninstall.join('\n')}` };
}

function schedulerPaths(ctx) {
  const home = ctx.env?.HOME;
  if (!home) throw new BrainAtlasError('E_NO_HOME', 'HOME must be provided to manage the sync scheduler.');
  const platform = ctx.env?.BRAINATLAS_PLATFORM || process.platform;
  return {
    platform,
    paths: {
      ...ctx.paths,
      home,
      launchAgentsDir: join(home, 'Library', 'LaunchAgents'),
      systemdUserDir: join(ctx.env?.XDG_CONFIG_HOME || join(home, '.config'), 'systemd', 'user'),
    },
  };
}

function parseScheduleArgs(args) {
  if (!Array.isArray(args)) {
    const action = args?.action ?? args?.subcommand ?? args?.command;
    return { action, intervalMin: args?.intervalMin ?? args?.interval, plan: args?.plan === true };
  }
  let action;
  let intervalMin;
  let plan = false;
  for (let index = 1; index < args.length; index++) {
    const value = args[index];
    if (value === '--plan') plan = true;
    else if (value === '--json') continue;
    else if (value === '--interval') {
      if (!args[index + 1] || args[index + 1].startsWith('--')) throw new BrainAtlasError('E_ARGUMENT', 'Missing value for --interval.');
      intervalMin = Number(args[++index]);
    } else if (typeof value === 'string' && value.startsWith('--interval=')) intervalMin = Number(value.slice('--interval='.length));
    else if (!action) action = value;
    else throw new BrainAtlasError('E_ARGUMENT', 'Scheduler arguments are invalid.');
  }
  if (!['install', 'remove', 'status'].includes(action)) throw new BrainAtlasError('E_ARGUMENT', 'Scheduler action is invalid.');
  if (action !== 'install' && intervalMin !== undefined) throw new BrainAtlasError('E_ARGUMENT', 'The scheduler interval is only valid for install.');
  if (action === 'status' && plan) throw new BrainAtlasError('E_ARGUMENT', 'The scheduler status command does not support --plan.');
  return { action, intervalMin, plan };
}

async function pathExists(path) {
  try { await lstat(path); return true; }
  catch (cause) { if (cause?.code === 'ENOENT') return false; throw cause; }
}

async function readManifest(path, expectedPaths) {
  let parsed;
  try { parsed = JSON.parse(await readFile(path, 'utf8')); }
  catch (cause) {
    if (cause?.code === 'ENOENT') return null;
    throw new BrainAtlasError('E_STATE_INVALID', 'Scheduler state is invalid.');
  }
  if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.files)
      || parsed.files.some((row) => !expectedPaths.includes(row.path) || !/^[a-f0-9]{64}$/.test(row.sha256) || row.mode !== 0o600)) {
    throw new BrainAtlasError('E_STATE_INVALID', 'Scheduler state is invalid.');
  }
  return parsed;
}

async function writeSchedulerFile(path, contents, ctx, paths, errorCode, message) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  let handle;
  let created = false;
  try {
    await assertSchedulerPaths(ctx, paths, [path]);
    handle = await open(temp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
    created = true;
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await assertSchedulerPaths(ctx, paths, [path]);
    await rename(temp, path);
  } catch (cause) {
    await handle?.close().catch(() => {});
    if (created) await rm(temp, { force: true }).catch(() => {});
    if (cause?.code === 'E_PATH_ESCAPE') throw cause;
    throw new BrainAtlasError(errorCode, message);
  }
}

async function writeManifest(path, manifest, ctx, paths) {
  await writeSchedulerFile(path, `${JSON.stringify(manifest, null, 2)}\n`, ctx, paths, 'E_STATE_WRITE', 'Could not update scheduler state.');
}

async function writeManagedFile(file, ctx, paths) {
  await writeSchedulerFile(file.path, file.contents, ctx, paths, 'E_SCHEDULER_WRITE', 'Could not write scheduler files.');
}

async function ensureLogFile(path) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let handle;
  try {
    handle = await open(path, O_APPEND | O_CREAT | O_NOFOLLOW | O_WRONLY, 0o600);
    if (!(await handle.stat()).isFile()) throw new Error();
    await handle.chmod(0o600);
  }
  catch { throw new BrainAtlasError('E_SCHEDULER_WRITE', 'Could not prepare scheduler log.'); }
  finally { await handle?.close(); }
}

function uidFor(ctx) {
  const injected = ctx.env?.UID;
  if (injected !== undefined && /^\d+$/.test(injected)) return injected;
  if (typeof process.getuid === 'function') return String(process.getuid());
  throw new BrainAtlasError('E_SCHEDULER_CONTEXT', 'The scheduler user could not be determined.');
}

function hostCommands(action, platform, ctx, files) {
  if (platform === 'darwin') {
    const target = files[0].path;
    const domain = `gui/${uidFor(ctx)}`;
    if (action === 'install') return [['launchctl', ['bootstrap', domain, target]]];
    if (action === 'remove') return [['launchctl', ['bootout', domain, target]]];
    return [['launchctl', ['print', `${domain}/org.brainatlas.sync`]]];
  }
  if (action === 'install') return [
    ['systemctl', ['--user', 'daemon-reload']],
    ['systemctl', ['--user', 'enable', '--now', 'brainatlas-sync.timer']],
  ];
  if (action === 'remove') return [['systemctl', ['--user', 'disable', '--now', 'brainatlas-sync.timer']]];
  return [
    ['systemctl', ['--user', 'is-enabled', 'brainatlas-sync.timer']],
    ['systemctl', ['--user', 'is-active', 'brainatlas-sync.timer']],
  ];
}

async function invoke(ctx, command, args) {
  const run = ctx.runCommand ?? ctx.core?.runCommand ?? defaultRunCommand;
  let result;
  try { result = await run(command, args, { env: ctx.env ?? process.env, timeoutMs: 15_000 }); }
  catch { throw commandError(); }
  const code = Number.isInteger(result?.code) ? result.code : Number.isInteger(result?.exitCode) ? result.exitCode : 0;
  return {
    code,
    stdout: typeof result?.stdout === 'string' ? result.stdout : '',
    stderr: typeof result?.stderr === 'string' ? result.stderr : '',
  };
}

function isAlreadyStopped(platform, result) {
  if (platform === 'darwin' && result.code === 3) return true;
  const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
  if (platform === 'darwin') {
    return /no such process|could not find service|service[^\n]*(?:not found|does not exist)/.test(output);
  }
  return /not-found|not found|not loaded|could not be found|unit file[^\n]*does not exist|already disabled|not enabled|\bdisabled\b/.test(output);
}

async function stopScheduler(ctx, platform, files) {
  const [[command, args]] = hostCommands('remove', platform, ctx, files);
  let result;
  try { result = await invoke(ctx, command, args); }
  catch { throw schedulerStopError(); }
  if (result.code !== 0 && !isAlreadyStopped(platform, result)) throw schedulerStopError();
  return { command, args, code: result.code, stdout: result.stdout, stderr: result.stderr };
}

async function runCommands(ctx, calls, { allowFailure = false } = {}) {
  const results = [];
  for (const [command, args] of calls) {
    let result;
    try { result = await invoke(ctx, command, args); }
    catch (cause) {
      if (!allowFailure) throw cause;
      results.push({ command, args, code: 127, stdout: '' });
      continue;
    }
    results.push({ command, args, code: result.code, stdout: result.stdout });
    if (result.code !== 0 && !allowFailure) throw commandError();
  }
  return results;
}

async function installScheduler(ctx, platform, paths, intervalMin) {
  const plan = planScheduler({ platform, paths, intervalMin });
  const statePath = schedulerStatePath(paths.stateDir);
  const protectedPaths = [...plan.files.map((file) => file.path), plan.logPath, statePath];
  await assertSchedulerPaths(ctx, paths, protectedPaths);
  const previous = await readManifest(statePath, plan.uninstall);
  const previousRows = new Map((previous?.files ?? []).map((row) => [row.path, row]));
  const originals = new Map();
  for (const file of plan.files) {
    if (!(await pathExists(file.path))) { originals.set(file.path, null); continue; }
    const old = previousRows.get(file.path);
    if (!old) throw new BrainAtlasError('E_SCHEDULER_EXISTS', 'A scheduler file already exists and is not managed.');
    let bytes; let stat;
    try { [bytes, stat] = await Promise.all([readFile(file.path), lstat(file.path)]); }
    catch { throw new BrainAtlasError('E_SCHEDULER_CONFLICT', 'A managed scheduler file changed after installation.'); }
    if (digest(bytes) !== old.sha256 || (stat.mode & 0o777) !== old.mode || !stat.isFile() || stat.isSymbolicLink()) {
      throw new BrainAtlasError('E_SCHEDULER_CONFLICT', 'A managed scheduler file changed after installation.');
    }
    originals.set(file.path, { bytes, mode: stat.mode & 0o777 });
  }
  const logExisted = await pathExists(plan.logPath);
  const newRows = plan.files.map((file) => ({ path: file.path, sha256: digest(Buffer.from(file.contents)), mode: 0o600 }));
  let schedulerStartAttempted = false;
  try {
    await assertSchedulerPaths(ctx, paths, protectedPaths);
    for (const file of plan.files) await writeManagedFile(file, ctx, paths);
    await ensureLogFile(plan.logPath);
    await assertSchedulerPaths(ctx, paths, protectedPaths);
    schedulerStartAttempted = true;
    await runCommands(ctx, hostCommands('install', platform, ctx, plan.files));
    await writeManifest(statePath, { schemaVersion: 1, platform, intervalMin, files: newRows }, ctx, paths);
  } catch (cause) {
    if (schedulerStartAttempted && cause?.code !== 'E_PATH_ESCAPE') {
      await runCommands(ctx, hostCommands('remove', platform, ctx, plan.files), { allowFailure: true }).catch(() => {});
    }
    for (const file of plan.files) {
      try { await assertSchedulerPaths(ctx, paths, [file.path]); }
      catch { continue; }
      const current = await readFile(file.path).catch(() => null);
      if (!current || digest(current) !== digest(Buffer.from(file.contents))) continue;
      const original = originals.get(file.path);
      if (original) {
        await writeManagedFile({ path: file.path, contents: original.bytes }, ctx, paths).catch(() => {});
        await chmod(file.path, original.mode).catch(() => {});
      } else await rm(file.path, { force: true }).catch(() => {});
    }
    if (platform === 'linux' && cause?.code !== 'E_PATH_ESCAPE') await runCommands(ctx, [['systemctl', ['--user', 'daemon-reload']]], { allowFailure: true }).catch(() => {});
    if (!logExisted) await rm(plan.logPath, { force: true }).catch(() => {});
    if (cause?.code === 'E_SCHEDULER_EXISTS' || cause?.code === 'E_SCHEDULER_CONFLICT' || cause?.code === 'E_SCHEDULER_COMMAND') throw cause;
    throw cause;
  }
  return { action: 'install', platform, intervalMin, files: plan.uninstall, logFile: plan.logPath, status: 'installed' };
}

async function removeScheduler(ctx, platform, paths) {
  const plan = planScheduler({ platform, paths });
  const statePath = schedulerStatePath(paths.stateDir);
  const protectedPaths = [...plan.files.map((file) => file.path), schedulerLogPath(paths.stateDir), statePath];
  await assertSchedulerPaths(ctx, paths, protectedPaths);
  const manifest = await readManifest(statePath, plan.uninstall);
  const hasManagedFiles = Boolean(manifest?.files.length);
  let results = [];
  if (hasManagedFiles) {
    await assertSchedulerPaths(ctx, paths, protectedPaths);
    results = [await stopScheduler(ctx, platform, plan.files)];
  }
  const removed = []; const preserved = [];
  const rows = new Map((manifest?.files ?? []).map((row) => [row.path, row]));
  for (const file of plan.files) {
    await assertSchedulerPaths(ctx, paths, [file.path]);
    const owned = rows.get(file.path);
    if (!owned) { preserved.push(file.path); continue; }
    let bytes; let stat;
    try { [bytes, stat] = await Promise.all([readFile(file.path), lstat(file.path)]); }
    catch (cause) { if (cause?.code === 'ENOENT') { removed.push(file.path); continue; } throw cause; }
    if (stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o777) === owned.mode && digest(bytes) === owned.sha256) {
      await rm(file.path, { force: true }); removed.push(file.path);
    } else preserved.push(file.path);
  }
  if (platform === 'linux' && hasManagedFiles) results.push(...await runCommands(ctx, [['systemctl', ['--user', 'daemon-reload']]], { allowFailure: true }));
  if (manifest) {
    await assertSchedulerPaths(ctx, paths, [statePath]);
    await rm(statePath, { force: true });
  }
  return { action: 'remove', platform, removed, preserved, commands: results.map(({ command, args, code }) => ({ command, args, code })) };
}

async function schedulerStatus(ctx, platform, paths) {
  const plan = planScheduler({ platform, paths });
  const statePath = schedulerStatePath(paths.stateDir);
  const manifest = await readManifest(statePath, plan.uninstall);
  const owned = new Map((manifest?.files ?? []).map((row) => [row.path, row]));
  const files = await Promise.all(plan.files.map(async (file) => ({
    path: file.path,
    exists: await pathExists(file.path),
    managed: owned.has(file.path),
  })));
  const results = await runCommands(ctx, hostCommands('status', platform, ctx, plan.files), { allowFailure: true });
  const checks = platform === 'darwin'
    ? { loaded: results[0]?.code === 0 }
    : { enabled: results[0]?.code === 0, active: results[1]?.code === 0 };
  return { action: 'status', platform, status: manifest && files.every((file) => file.exists && file.managed) ? 'installed' : 'not-installed', intervalMin: manifest?.intervalMin ?? null, logFile: plan.logPath, files, ...checks };
}

/** Handle the user-level sync schedule command. */
export async function scheduleCommand(args, ctx = {}) {
  const options = parseScheduleArgs(args);
  const { platform, paths } = schedulerPaths(ctx);
  const intervalMin = options.intervalMin ?? 30;
  if (options.action === 'install' && options.plan) return { action: 'install', ...planScheduler({ platform, paths, intervalMin }) };
  if (options.action === 'remove' && options.plan) return { action: 'remove', ...planSchedulerUninstall({ platform, paths }) };
  if (options.action === 'install') return installScheduler(ctx, platform, paths, intervalMin);
  if (options.action === 'remove') return removeScheduler(ctx, platform, paths);
  return schedulerStatus(ctx, platform, paths);
}
