// SPDX-License-Identifier: MIT
import { resolve } from 'node:path';

const TOOL_FOR = {
  list: 'plan_read',
  show: 'plan_read',
  new: 'plan_update',
  add: 'plan_update',
  set: 'plan_update',
};

const ALLOWED_OPTIONS = {
  list: new Set(),
  show: new Set(['--max-chars']),
  new: new Set(['--title', '--purpose', '--status', '--expect-sha256', '--dry-run']),
  add: new Set(['--status', '--id', '--expect-sha256', '--dry-run']),
  set: new Set(['--expect-sha256', '--dry-run']),
};

const failure = (code, message) => Object.assign(new Error(message), { code });

function integerOption(name, raw) {
  if (!/^-?\d+$/u.test(raw) || !Number.isSafeInteger(Number(raw)))
    throw failure('E_ARGUMENT', `${name} must be an integer.`);
  return Number(raw);
}

function shaOption(raw) {
  if (!/^[0-9a-fA-F]{64}$/u.test(raw))
    throw failure('E_ARGUMENT', '--expect-sha256 must be a 64-character hex SHA-256.');
  return raw;
}

export function parsePlanArguments(argv) {
  const sub = argv[0];
  if (sub === undefined || sub.startsWith('-') || !Object.hasOwn(TOOL_FOR, sub))
    throw failure('E_ARGUMENT', 'plan requires one of: list, show, new, add, set.');
  const allowed = ALLOWED_OPTIONS[sub];
  const positional = [];
  const options = {};
  let vault;
  for (let index = 1; index < argv.length; index++) {
    const token = argv[index];
    if (token === '--json') continue;
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const equals = token.indexOf('=');
    const name = equals < 0 ? token : token.slice(0, equals);
    if (name !== '--vault' && !allowed.has(name))
      throw failure('E_ARGUMENT', `Unknown option for plan ${sub}: ${name}.`);
    if (name === '--dry-run') {
      if (equals >= 0) throw failure('E_ARGUMENT', '--dry-run does not take a value.');
      options['--dry-run'] = true;
      continue;
    }
    let raw;
    if (equals >= 0) raw = token.slice(equals + 1);
    else {
      raw = argv[++index];
      if (raw === undefined || raw.startsWith('--')) throw failure('E_ARGUMENT', `Missing value for ${name}.`);
    }
    if (name === '--vault') vault = raw;
    else options[name] = raw;
  }
  if (sub === 'list' && positional.length) throw failure('E_ARGUMENT', 'plan list accepts no positional arguments.');
  if (sub === 'show') {
    if (!positional.length) throw failure('E_ARGUMENT', 'plan show requires a project.');
    if (positional.length > 1) throw failure('E_ARGUMENT', 'plan show accepts one project.');
  }
  if (sub === 'new') {
    if (!positional.length) throw failure('E_ARGUMENT', 'plan new requires a slug.');
    if (positional.length > 1) throw failure('E_ARGUMENT', 'plan new accepts one slug.');
    if (options['--title'] === undefined) throw failure('E_ARGUMENT', 'plan new requires --title.');
    if (options['--purpose'] === undefined) throw failure('E_ARGUMENT', 'plan new requires --purpose.');
  }
  if (sub === 'add') {
    if (positional.length < 2) throw failure('E_ARGUMENT', 'plan add requires a project and a title.');
  }
  if (sub === 'set') {
    if (positional.length < 2) throw failure('E_ARGUMENT', 'plan set requires a project and a status.');
    if (positional.length > 3)
      throw failure('E_ARGUMENT', 'plan set accepts a project, an optional task and a status.');
  }

  const args = {};
  if (sub === 'show') {
    args.project = positional[0];
    if (options['--max-chars'] !== undefined) args.maxChars = integerOption('--max-chars', options['--max-chars']);
  } else if (sub === 'new') {
    args.op = 'add_project';
    args.slug = positional[0];
    args.title = options['--title'];
    args.purpose = options['--purpose'];
    if (options['--status'] !== undefined) args.status = options['--status'];
  } else if (sub === 'add') {
    args.op = 'add_task';
    args.project = positional[0];
    args.title = positional.slice(1).join(' ');
    if (options['--status'] !== undefined) args.status = options['--status'];
    if (options['--id'] !== undefined) args.id = options['--id'];
  } else if (sub === 'set') {
    args.op = 'set_status';
    args.project = positional[0];
    if (positional.length === 3) args.task = positional[1];
    args.status = positional.at(-1);
  }
  if (options['--expect-sha256'] !== undefined) args.expectedSha256 = shaOption(options['--expect-sha256']);
  const dryRun = options['--dry-run'] === true;
  return { sub, vault, args, ...(dryRun ? { dryRun: true } : {}) };
}

function toolFailure(text) {
  const match = /^(E_[A-Z0-9_]+): ([\s\S]*)$/u.exec(text);
  if (!match) return failure('E_PLAN_TOOL', text);
  return failure(match[1], match[2]);
}

export async function runPlanCommand(argv, { env = process.env } = {}) {
  const { sub, vault, args, dryRun = false } = parsePlanArguments(argv);
  const { callToolInProcess, serverOptions } = await import('@brainatlas/mcp');
  /** @type {{config:any, paths:any, env:any, dryRun?:boolean}} */
  const options = await serverOptions(env);
  if (vault !== undefined) options.paths.vaultDir = resolve(vault);
  const changes = sub !== 'list' && sub !== 'show';
  if (changes && options.config.readOnly === true)
    throw failure('E_READ_ONLY', 'The vault is read-only (readOnly: true).');
  if (changes && dryRun) options.dryRun = true;
  const result = await callToolInProcess(options, TOOL_FOR[sub], args);
  if (result.isError) throw toolFailure(result.text);
  let value;
  try {
    value = JSON.parse(result.text);
  } catch {
    throw failure('E_PLAN_TOOL', 'The planning tool returned an unreadable response.');
  }
  return { sub, value };
}

export function formatPlanResult(sub, value) {
  if (sub === 'list') {
    const projects = Array.isArray(value?.projects) ? value.projects : [];
    return projects
      .map((project) => `${project.id} · ${project.title} · ${project.status} · ${project.file}`)
      .join('\n');
  }
  if (sub === 'show') {
    const tasks = Array.isArray(value?.tasks) ? value.tasks : [];
    return tasks
      .map((task) => `${task.id} · ${task.title} [${task.status}]${task.date ? ` (${task.date})` : ''}`)
      .join('\n');
  }
  return value?.dryRun === true ? `dry run: ${value?.op}: ${value?.file}` : `${value?.op}: ${value?.file}`;
}
