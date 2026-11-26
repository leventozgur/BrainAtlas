// SPDX-License-Identifier: MIT
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { runCommand as defaultRunCommand } from '../../../packages/core/src/util/index.mjs';
import { BrainAtlasError } from '../../../packages/core/src/util/errors.mjs';

const LABEL = 'org.brainatlas.maintain';
const UNIT = 'brainatlas-maintain';
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const fail = (code, message) => new BrainAtlasError(code, message);
const digest = (text) => createHash('sha256').update(text).digest('hex');
const xml = (value) =>
  String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
const unitQuote = (value) =>
  `"${String(value)
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('%', '%%')
    .replaceAll('$', () => '$$')}"`;

function within(root, path) {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * @param {{platform?:string,binPath?:string,home?:string,configHome?:string,day?:string,hour?:number}} [options]
 */
export function planSchedule({ platform, binPath, home, configHome, day = 'mon', hour = 9 } = {}) {
  const weekday = DAYS.indexOf(day);
  if (!['darwin', 'linux'].includes(platform) || typeof binPath !== 'string' || !binPath || typeof home !== 'string')
    throw fail('E_ARGUMENT', 'Scheduler plan input is invalid.');
  if (weekday < 0 || !Number.isInteger(hour) || hour < 0 || hour > 23)
    throw fail('E_ARGUMENT', 'Use --day sun..sat and --hour 0..23.');
  if (platform === 'darwin') {
    const path = join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
    const contents = `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>\n<key>Label</key><string>${LABEL}</string>\n<key>ProgramArguments</key><array><string>${xml(binPath)}</string><string>maintain</string><string>--weekly</string></array>\n<key>StartCalendarInterval</key><dict><key>Weekday</key><integer>${weekday}</integer><key>Hour</key><integer>${hour}</integer><key>Minute</key><integer>0</integer></dict>\n</dict></plist>\n`;
    return { platform, day, hour, files: [{ path, contents }] };
  }
  const root = join(configHome || join(home, '.config'), 'systemd', 'user');
  return {
    platform,
    day,
    hour,
    files: [
      {
        path: join(root, `${UNIT}.service`),
        contents: `[Unit]\nDescription=BrainAtlas weekly maintenance\n\n[Service]\nType=oneshot\nExecStart=${unitQuote(binPath)} maintain --weekly\n`,
      },
      {
        path: join(root, `${UNIT}.timer`),
        contents: `[Unit]\nDescription=Run BrainAtlas weekly maintenance\n\n[Timer]\nOnCalendar=${day[0].toUpperCase()}${day.slice(1)} *-*-* ${String(hour).padStart(2, '0')}:00:00\nPersistent=true\nUnit=${UNIT}.service\n\n[Install]\nWantedBy=timers.target\n`,
      },
    ],
  };
}

function hostCommands(action, platform, file0, uid) {
  if (platform === 'darwin') {
    const domain = `gui/${uid}`;
    if (action === 'install') return [['launchctl', ['bootstrap', domain, file0]]];
    if (action === 'remove') return [['launchctl', ['bootout', domain, file0]]];
    return [['launchctl', ['print', `${domain}/${LABEL}`]]];
  }
  if (action === 'install')
    return [
      ['systemctl', ['--user', 'daemon-reload']],
      ['systemctl', ['--user', 'enable', '--now', `${UNIT}.timer`]],
      ['systemctl', ['--user', 'restart', `${UNIT}.timer`]],
    ];
  if (action === 'remove') return [['systemctl', ['--user', 'disable', '--now', `${UNIT}.timer`]]];
  return [['systemctl', ['--user', 'is-enabled', `${UNIT}.timer`]]];
}

/**
 * @param {string} platform
 * @param {string} file0
 * @param {string|number} uid
 * @returns {{before:Array<{command:string,args:string[],allowFailure:boolean}>,after:Array<{command:string,args:string[],allowFailure:boolean}>}}
 */
function installSteps(platform, file0, uid) {
  const step = (command, args, allowFailure = false) => ({ command, args, allowFailure });
  const before = platform === 'darwin' ? [step('launchctl', ['bootout', `gui/${uid}/${LABEL}`], true)] : [];
  const after =
    platform === 'darwin'
      ? [step('launchctl', ['bootstrap', `gui/${uid}`, file0])]
      : hostCommands('install', platform, file0, uid).map(([command, args]) => step(command, args));
  return { before, after };
}

function context(ctx) {
  const env = ctx?.env ?? process.env;
  const home = env.HOME;
  const stateDir = ctx?.paths?.stateDir;
  const binPath = ctx?.paths?.binPath;
  if (!home || typeof stateDir !== 'string' || typeof binPath !== 'string')
    throw fail('E_MODULE_CONTEXT', 'Scheduler context is incomplete.');
  const uid = env.UID && /^\d+$/.test(env.UID) ? env.UID : typeof process.getuid === 'function' ? process.getuid() : 0;
  return {
    env,
    home,
    binPath,
    uid,
    platform: env.BRAINATLAS_PLATFORM || process.platform,
    configHome: env.XDG_CONFIG_HOME,
    statePath: join(stateDir, 'maintain-schedule.json'),
    run: ctx.runCommand ?? defaultRunCommand,
  };
}

async function assertInsideHome(c, files) {
  const home = await realpath(c.home).catch(() => {
    throw fail('E_PATH_ESCAPE', 'Scheduler paths must resolve within HOME.');
  });
  for (const file of files) {
    const info = await lstat(file).catch(() => null);
    if (info?.isSymbolicLink()) throw fail('E_PATH_ESCAPE', 'Scheduler paths must resolve within HOME.');
    let dir = dirname(file);
    const tail = [];
    for (;;) {
      try {
        dir = await realpath(dir);
        break;
      } catch {
        tail.unshift(basename(dir));
        const parent = dirname(dir);
        if (parent === dir) throw fail('E_PATH_ESCAPE', 'Scheduler paths must resolve within HOME.');
        dir = parent;
      }
    }
    if (c.env.BRAINATLAS_ALLOW_SYMLINKED_ROOT !== '1' && !within(home, resolve(dir, ...tail)))
      throw fail('E_PATH_ESCAPE', 'Scheduler paths must resolve within HOME.');
  }
}

async function readState(path) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.files)) throw new Error();
    return parsed;
  } catch (cause) {
    if (cause?.code === 'ENOENT') return null;
    throw fail('E_STATE_INVALID', 'Scheduler state is invalid.');
  }
}

async function writeAtomic(path, contents) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  await writeFile(temp, contents, { mode: 0o600, flag: 'wx' });
  await rename(temp, path);
}

async function exec(c, command, args, { allowFailure = false } = {}) {
  let result;
  try {
    result = await c.run(command, args, { env: c.env, timeoutMs: 15_000 });
  } catch {
    if (allowFailure) return { command, args, code: 127 };
    throw fail('E_SCHEDULER_COMMAND', 'Scheduler command failed.');
  }
  const code = Number.isInteger(result?.code) ? result.code : Number.isInteger(result?.exitCode) ? result.exitCode : 0;
  if (code !== 0 && !allowFailure) throw fail('E_SCHEDULER_COMMAND', 'Scheduler command failed.');
  return { command, args, code };
}

function parseArgs(args) {
  const list = Array.isArray(args) ? args : [];
  let action;
  let day = 'mon';
  let hour = 9;
  let plan = false;
  for (let i = 0; i < list.length; i++) {
    const value = list[i];
    if (value === '--plan') plan = true;
    else if (value === '--json') continue;
    else if (value === '--day' || value === '--hour') {
      const next = list[++i];
      if (next === undefined || next.startsWith('--')) throw fail('E_ARGUMENT', `Missing value for ${value}.`);
      if (value === '--day') day = next;
      else hour = /^\d+$/.test(next) ? Number(next) : Number.NaN;
    } else if (!action) action = value;
    else throw fail('E_ARGUMENT', 'Scheduler arguments are invalid.');
  }
  if (!['install', 'remove', 'status'].includes(action)) throw fail('E_ARGUMENT', 'Scheduler action is invalid.');
  if (action === 'status' && plan) throw fail('E_ARGUMENT', 'The status command does not support --plan.');
  return { action, day, hour, plan };
}

/**
 * @param {{statePath:string}} c
 * @param {Array<{path:string,contents:Buffer|null}>} previous
 * @param {Buffer|null} previousState
 */
async function restorePrevious(c, previous, previousState) {
  for (const row of previous) {
    if (row.contents === null) await rm(row.path, { force: true });
    else await writeAtomic(row.path, row.contents);
  }
  if (previousState === null) await rm(c.statePath, { force: true });
  else await writeAtomic(c.statePath, previousState);
}

async function install(c, { day, hour, plan }) {
  const spec = planSchedule({
    platform: c.platform,
    binPath: c.binPath,
    home: c.home,
    configHome: c.configHome,
    day,
    hour,
  });
  if (plan)
    return { action: 'install', ...spec, files: spec.files.map((f) => ({ path: f.path, contents: f.contents })) };
  const paths = spec.files.map((f) => f.path);
  await assertInsideHome(c, [...paths, c.statePath]);
  const state = await readState(c.statePath);
  const owned = new Map((state?.files ?? []).map((row) => [row.path, row.sha256]));
  const previous = [];
  for (const file of spec.files) {
    const existing = await readFile(file.path).catch(() => null);
    if (existing === null) {
      if (owned.has(file.path))
        throw fail('E_SCHEDULER_CONFLICT', 'A managed scheduler file is missing after installation.');
    } else {
      if (!owned.has(file.path))
        throw fail('E_SCHEDULER_EXISTS', 'A scheduler file already exists and is not managed.');
      if (digest(existing) !== owned.get(file.path))
        throw fail('E_SCHEDULER_CONFLICT', 'A managed scheduler file changed after installation.');
    }
    previous.push({ path: file.path, contents: existing });
  }
  const previousState = await readFile(c.statePath).catch(() => null);
  const reinstall = previous.some((row) => row.contents !== null);
  const steps = installSteps(c.platform, paths[0], c.uid);
  try {
    for (const step of steps.before) await exec(c, step.command, step.args, { allowFailure: step.allowFailure });
    for (const file of spec.files) await writeAtomic(file.path, file.contents);
    for (const step of steps.after) await exec(c, step.command, step.args, { allowFailure: step.allowFailure });
    await writeAtomic(
      c.statePath,
      `${JSON.stringify({ schemaVersion: 1, platform: c.platform, day, hour, files: spec.files.map((f) => ({ path: f.path, sha256: digest(f.contents) })) }, null, 2)}\n`
    );
  } catch (cause) {
    try {
      await restorePrevious(c, previous, previousState);
      if (reinstall) {
        const reload =
          c.platform === 'darwin'
            ? [...steps.before, ...steps.after].map((step) => [step.command, step.args])
            : hostCommands('install', c.platform, paths[0], c.uid).slice(0, 2);
        for (const [command, args] of reload) await exec(c, command, args, { allowFailure: true });
      } else {
        for (const [command, args] of hostCommands('remove', c.platform, paths[0], c.uid))
          await exec(c, command, args, { allowFailure: true });
      }
    } catch (rollbackError) {
      cause.rollbackError = rollbackError;
      cause.message = `${cause.message} (rollback failed: ${rollbackError.message})`;
    }
    throw cause;
  }
  return { action: 'install', platform: c.platform, day, hour, files: paths, status: 'installed' };
}

async function remove(c, { plan }) {
  const spec = planSchedule({ platform: c.platform, binPath: c.binPath, home: c.home, configHome: c.configHome });
  const paths = spec.files.map((f) => f.path);
  if (plan) return { action: 'remove', platform: c.platform, files: paths };
  await assertInsideHome(c, [...paths, c.statePath]);
  const state = await readState(c.statePath);
  if (!state) return { action: 'remove', platform: c.platform, removed: [], preserved: paths, commands: [] };
  const commands = [];
  for (const [command, args] of hostCommands('remove', c.platform, paths[0], c.uid))
    commands.push(await exec(c, command, args, { allowFailure: true }));
  const removed = [];
  const preserved = [];
  const owned = new Map(state.files.map((row) => [row.path, row.sha256]));
  for (const path of paths) {
    const existing = await readFile(path, 'utf8').catch(() => null);
    if (existing === null) removed.push(path);
    else if (owned.get(path) === digest(existing)) {
      await rm(path, { force: true });
      removed.push(path);
    } else preserved.push(path);
  }
  if (c.platform === 'linux')
    commands.push(await exec(c, 'systemctl', ['--user', 'daemon-reload'], { allowFailure: true }));
  await rm(c.statePath, { force: true });
  return { action: 'remove', platform: c.platform, removed, preserved, commands };
}

async function status(c) {
  const spec = planSchedule({ platform: c.platform, binPath: c.binPath, home: c.home, configHome: c.configHome });
  const state = await readState(c.statePath);
  const files = await Promise.all(
    spec.files.map(async (f) => ({
      path: f.path,
      exists: (await lstat(f.path).catch(() => null)) !== null,
      managed: (state?.files ?? []).some((row) => row.path === f.path),
    }))
  );
  const results = [];
  for (const [command, args] of hostCommands('status', c.platform, spec.files[0].path, c.uid))
    results.push(await exec(c, command, args, { allowFailure: true }));
  return {
    action: 'status',
    platform: c.platform,
    status: state && files.every((f) => f.exists && f.managed) ? 'installed' : 'not-installed',
    day: state?.day ?? null,
    hour: state?.hour ?? null,
    files,
    active: results[results.length - 1]?.code === 0,
  };
}

export async function scheduleCommand(args, ctx = {}) {
  const options = parseArgs(args);
  const c = context(ctx);
  if (options.action === 'install') return install(c, options);
  if (options.action === 'remove') return remove(c, options);
  return status(c);
}

export async function activate(ctx) {
  if (!ctx || !ctx.config || !ctx.paths)
    throw fail('E_MODULE_CONTEXT', 'Maintain schedule module context is incomplete.');
}

export const commands = Object.freeze({
  'maintain-schedule': (argsOrContext, contextOrArgs) => {
    const firstIsContext = argsOrContext && !Array.isArray(argsOrContext) && argsOrContext.paths;
    return scheduleCommand(
      firstIsContext ? contextOrArgs : argsOrContext,
      firstIsContext ? argsOrContext : contextOrArgs
    );
  },
});

export const help = Object.freeze({
  'maintain-schedule': Object.freeze({
    usage: Object.freeze([
      'brainatlas maintain-schedule install [--day sun..sat] [--hour 0..23] [--plan] [--json]',
      'brainatlas maintain-schedule remove [--plan]',
      'brainatlas maintain-schedule status [--json]',
    ]),
    description: 'Install, remove or inspect a weekly OS timer that runs brainatlas maintain --weekly.',
  }),
});
