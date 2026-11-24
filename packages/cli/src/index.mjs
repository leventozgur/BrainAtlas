// SPDX-License-Identifier: MIT
import { defaultConfig, loadConfig, resolvePaths } from '@brainatlas/core';
import {
  error,
  readCurrent,
  currentReleaseDir,
  enabledModuleEntries,
  providedTransportName,
  redactOutput,
} from './commands/shared.mjs';
import * as lifecycle from './commands/lifecycle.mjs';
import * as setup from './commands/setup.mjs';
import * as configCommands from './commands/config.mjs';
import * as tools from './commands/tools.mjs';
import { agentCommand } from './commands/agent.mjs';
import { uiCommand } from './ui.mjs';
import { dispatchModuleCommand } from './commands/sync.mjs';
export { hookCommandFor } from './commands/tools.mjs';

const helpDescriptions = Object.freeze({
  init: 'Create a BrainAtlas configuration and initialize a vault.',
  install: 'Install a BrainAtlas release.',
  status: 'Show installation status.',
  doctor: 'Check installation health.',
  config: 'Read or change BrainAtlas configuration.',
  safety: 'Review and manage fingerprinted safety allowances.',
  module: 'List, add, or remove installed modules.',
  agent: 'List, add, remove an agent or switch its channel.',
  uninstall: 'Remove BrainAtlas while preserving the vault.',
  update: 'Install or inspect a release update.',
  rollback: 'Switch to a previous release.',
  recover: 'Inspect or recover an interrupted update.',
  eval: 'Run the local retrieval evaluation.',
  hook: 'Run an agent hook.',
  mcp: 'Start the BrainAtlas MCP server.',
  migrate:
    'Copy vault content into a new vault. bodyHashMatch compares wiki page bodies except wiki/log.md; logPrefixPreserved confirms the exact source log bytes prefix the target log; logAppendedEntries is the number of migration log entries appended.',
  adopt: 'Inspect existing agent setup and propose adoption.',
  maintain:
    'Wiki maintenance report (read-only unless --queue); --fix (--plan | --apply) [--sources] repairs index lines, archived links and source lists; --weekly writes a read-only snapshot; --proposals reviews stored current-state proposals.',
  compact: 'Move older dated sections of one page verbatim into wiki/archive/<name>-history.md (--plan or --apply).',
  usage: 'Summarize hook metrics for the last days or record feedback.',
  wiki: 'Read-only Wiki tools from the shell (same results as the MCP read tools).',
  ui: '(experimental) Open a local browser panel for status, agent channels and settings (127.0.0.1 only).',
  help: 'Show built-in and active module commands.',
});
const helpUsages = Object.freeze({
  init: 'brainatlas init [--yes] [--vault PATH] [--profile lite|full] [--agents claude-code,copilot-vscode,kiro,codex,gemini-cli] [--channel mcp|cli|<agent>=<mcp|cli>,...] [--plan] [--json]',
  install: 'brainatlas install [--finalize]',
  status: 'brainatlas status [--summary] [--json]',
  doctor: 'brainatlas doctor [--json]',
  config: 'brainatlas config get [KEY] | set KEY VALUE [--plan] | unset KEY [--plan]',
  safety:
    'brainatlas safety allow <VAULT_RELATIVE_PATH> [--plan] [--json] | list [PATH] [--json] | revoke <PATH> [--plan] [--json]',
  module: 'brainatlas module list | add NAME --from ARCHIVE | remove NAME [--plan]',
  agent:
    'brainatlas agent list [--json] | agent add <agent> [--channel mcp|cli] [--plan] | agent remove <agent> [--plan] | agent set <agent> --channel mcp|cli [--plan]',
  uninstall: 'brainatlas uninstall [--plan]',
  update: 'brainatlas update --from ARCHIVE [--plan] | --check',
  rollback: 'brainatlas rollback [--to VERSION] [--plan]',
  recover: 'brainatlas recover [--plan]',
  eval: 'brainatlas eval [--cases FILE] [--corpus DIR]',
  hook: 'brainatlas hook CLIENT EVENT',
  mcp: 'brainatlas mcp',
  migrate: 'brainatlas migrate --from OLD_VAULT --to NEW_VAULT [--plan] [--json]',
  adopt: 'brainatlas adopt --plan [--json]',
  maintain:
    'brainatlas maintain [--json] [--vault PATH] [--queue] [--repo DIR] | brainatlas maintain --fix (--plan | --apply) [--sources] [--vault PATH] [--json] | brainatlas maintain --weekly [--vault PATH] [--json] | brainatlas maintain --proposals list|show <id>|accept <id>|reject <id> [--vault PATH] [--json]',
  compact:
    'brainatlas compact --page wiki/<path>.md (--plan | --apply) [--keep N] [--older-than YYYY-MM-DD] [--vault PATH] [--json]',
  usage: 'brainatlas usage [--days N] [--json] | brainatlas usage feedback useful|not-useful',
  wiki: 'brainatlas wiki query <text> [--limit N] [--compact] [--provenance] | read <path> [--anchor A] [--max-chars N] | index | list [--type T] | status | lint  [--vault PATH] [--json]',
  ui: 'brainatlas ui [--no-open] [--json]',
  help: 'brainatlas --help | brainatlas help [COMMAND]',
});

async function availableHelpCommands(paths, env) {
  /** @type {Array<{name:string,kind:string,usage:any,description:any,module?:string}>} */
  const commands = [...builtInCommands].map((name) => ({
    name,
    kind: 'built-in',
    usage: helpUsages[name],
    description: helpDescriptions[name],
  }));
  const current = await readCurrent(paths).catch(() => null);
  const releaseDir = currentReleaseDir(paths, current);
  if (releaseDir) {
    let cfg;
    try {
      cfg = await loadConfig({ paths, env });
    } catch {
      cfg = defaultConfig('lite');
    }
    try {
      const { ordered, entries } = await enabledModuleEntries(releaseDir, cfg);
      const seen = new Set(commands.map((item) => item.name));
      const moduleHelp = new Map();
      for (const manifest of ordered) {
        const entry = entries.get(manifest.name);
        for (const [name, help] of Object.entries(entry?.help || {})) {
          if (!moduleHelp.has(name)) moduleHelp.set(name, { usage: [], description: help?.description });
          const target = moduleHelp.get(name);
          for (const line of Array.isArray(help?.usage) ? help.usage : help?.usage ? [help.usage] : []) {
            if (!target.usage.includes(line)) target.usage.push(line);
          }
          if (!target.description && help?.description) target.description = help.description;
        }
        const transportName = providedTransportName(manifest);
        if (transportName && typeof entry?.commands?.status === 'function') {
          if (!moduleHelp.has('sync')) moduleHelp.set('sync', { usage: [] });
          moduleHelp.get('sync').usage.push(`brainatlas sync ${transportName} status [--json]`);
        }
        for (const name of Object.keys(entry?.commands || {}).sort()) {
          if (seen.has(name)) continue;
          seen.add(name);
          const help = moduleHelp.get(name);
          const usage = help?.usage?.length ? help.usage : [`brainatlas ${name} [ARGS]`];
          commands.push({
            name,
            kind: 'module',
            module: manifest.name,
            usage: usage.length === 1 ? usage[0] : usage,
            description: help?.description || `Command provided by the ${manifest.name} module.`,
          });
        }
      }
      // A transport module may add subcommands to sync without owning a top-level command.
      const sync = commands.find((item) => item.name === 'sync');
      const syncHelp = moduleHelp.get('sync');
      if (sync && syncHelp?.usage?.length) {
        const existing = Array.isArray(sync.usage) ? sync.usage : [sync.usage];
        const usage = [...existing];
        for (const line of syncHelp.usage) if (!usage.includes(line)) usage.push(line);
        sync.usage = usage;
      }
    } catch {
      /* Help remains usable when an installed module is damaged. */
    }
  }
  return commands.sort((a, b) => a.name.localeCompare(b.name));
}

async function showHelp(topic, { paths, env, output, json }) {
  const commands = await availableHelpCommands(paths, env);
  if (topic) {
    const command = commands.find((item) => item.name === topic);
    if (!command && topic === 'sync') {
      const moduleName = ['sync', 'engine'].join('-');
      const description = `sync is provided by the Full profile modules; install/enable ${moduleName}`;
      output(json ? { name: 'sync', kind: 'unavailable', usage: '', description } : description);
      return;
    }
    if (!command) throw error('E_COMMAND_UNKNOWN', 'Unknown command.');
    const usage = Array.isArray(command.usage) ? command.usage.join('\n') : command.usage;
    output(json ? command : `${usage}\n${command.description}`);
    return;
  }
  const result = { commands };
  const lines = [
    'BrainAtlas commands:',
    ...commands.map((item) => `  ${item.name.padEnd(14)} ${item.description}`),
    '',
    'Run "brainatlas help <command>" for command usage.',
  ];
  output(json ? result : lines.join('\n'));
}

// The documentation consistency check discovers built-in commands from `command === '<name>'`
// literals in this file. These mirror the dispatch keys below and must stay in sync with them.
// command === 'help'
// command === 'init', command === 'install', command === 'status', command === 'doctor'
// command === 'config', command === 'safety', command === 'module', command === 'uninstall'
// command === 'update', command === 'rollback', command === 'recover', command === 'eval'
// command === 'hook', command === 'mcp', command === 'migrate', command === 'adopt'
// command === 'maintain', command === 'compact', command === 'usage', command === 'wiki'
// command === 'agent', command === 'ui'
const dispatch = Object.freeze({
  init: setup.init,
  install: lifecycle.install,
  status: lifecycle.status,
  doctor: lifecycle.status,
  config: configCommands.configCommand,
  safety: configCommands.safety,
  module: configCommands.moduleCommand,
  agent: agentCommand,
  ui: uiCommand,
  uninstall: lifecycle.uninstall,
  update: lifecycle.update,
  rollback: lifecycle.rollback,
  recover: lifecycle.recover,
  eval: tools.evalCommand,
  hook: tools.hookOrMcp,
  mcp: tools.hookOrMcp,
  migrate: setup.migrate,
  adopt: setup.adopt,
  maintain: tools.maintain,
  compact: tools.compact,
  usage: tools.usage,
  wiki: tools.wiki,
});
const builtInCommands = new Set([...Object.keys(dispatch), 'help']);

export function enableOffline(env = process.env) {
  if (env.BRAINATLAS_OFFLINE === '1')
    globalThis.fetch = async () => {
      throw error('E_OFFLINE', 'Network access is disabled.');
    };
}
export async function main(argv = process.argv.slice(2), env = process.env, dependencies = {}) {
  const args = [...argv];
  const command = args.shift();
  const flag = (name) => args.includes(name);
  const value = (name) => {
    const i = args.indexOf(name);
    if (i < 0) return undefined;
    if (!args[i + 1] || args[i + 1].startsWith('--')) throw error('E_ARGUMENT', `Missing value for ${name}.`);
    return args[i + 1];
  };
  const paths = resolvePaths({ platform: env.BRAINATLAS_PLATFORM || process.platform, env });
  const json = flag('--json');
  const plan = flag('--plan');
  let redactCommandOutput = plan || (json && (command === 'status' || command === 'doctor'));
  const output = (data) => {
    const hideHome =
      plan && ['init', 'config', 'module', 'uninstall', 'update', 'rollback', 'recover', 'sync'].includes(command);
    const result = redactCommandOutput ? redactOutput(data, hideHome ? env.HOME : undefined) : data;
    console.log(
      json || plan
        ? JSON.stringify(result, null, 2)
        : typeof result === 'string'
          ? result
          : JSON.stringify(result, null, 2)
    );
  };
  if (command === '--help' || command === '-h' || command === 'help') {
    const topic = command === 'help' ? args.find((argument) => !argument.startsWith('--')) : undefined;
    await showHelp(topic, { paths, env, output, json });
    return;
  }
  const context = {
    command,
    args,
    flag,
    value,
    paths,
    env,
    json,
    plan,
    output,
    dependencies,
    markRedacted: () => {
      redactCommandOutput = true;
    },
  };
  const handler = Object.hasOwn(dispatch, command) ? dispatch[command] : null;
  if (handler) {
    await handler(context);
    return;
  }
  if (command && !builtInCommands.has(command)) {
    await dispatchModuleCommand(command, args, { paths, env, output, dependencies });
    return;
  }
  throw error(
    command ? 'E_ARGUMENT' : 'E_COMMAND_UNKNOWN',
    command ? 'Command arguments are invalid.' : 'Unknown command.'
  );
}
export const activate = main;
