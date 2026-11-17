// SPDX-License-Identifier: MIT
import { discoverModules, loadConfig } from '@brainatlas/core';
import { error, readCurrent, currentReleaseDir, loadInstalledModuleEntry, providedTransportName, moduleContext, enabledModuleEntries, activateEnabledModules } from './shared.mjs';

export async function dispatchModuleCommand(command, args, { paths, env, output, dependencies = {} }) {
  const current = await readCurrent(paths);
  const releaseDir = currentReleaseDir(paths, current);
  if (!releaseDir) throw error('E_COMMAND_UNKNOWN', 'Unknown command.');
  const cfg = await loadConfig({ paths, env, readOnly: ['semanticSetup'].includes(command) });
  const { ordered, entries } = await enabledModuleEntries(releaseDir, cfg);
  let owner; let ownerCommand = command; let ownerArgs = args;
  if (command === 'sync' && args.length) {
    const transportName = args[0];
    const transport = ordered.find(manifest => providedTransportName(manifest) === transportName);
    if (transport) {
      owner = transport;
      const entry = entries.get(transport.name);
      const action = args[1];
      if (typeof entry.commands?.[transportName] === 'function') {
        ownerCommand = transportName; ownerArgs = args.slice(1);
      } else if (action && typeof entry.commands?.[action] === 'function') {
        ownerCommand = action; ownerArgs = args.slice(2);
      } else if (typeof entry.commands?.sync === 'function') {
        ownerCommand = 'sync'; ownerArgs = args;
      } else {
        throw error('E_COMMAND_UNKNOWN', 'Unknown command.');
      }
    }
  }
  for (const manifest of ordered) {
    if (owner) break;
    const entry = entries.get(manifest.name);
    if (entry.commands && Object.hasOwn(entry.commands, command) && typeof entry.commands[command] === 'function') {
      owner = manifest;
      break;
    }
  }
  if (!owner) throw error('E_COMMAND_UNKNOWN', 'Unknown command.');
  const ctx = moduleContext(cfg, paths, env, entries, ordered, dependencies);
  await activateEnabledModules(ordered, entries, ctx);
  const commandEntry = entries.get(owner.name).commands[ownerCommand];
  let result;
  try { result = await commandEntry(ownerArgs, ctx); }
  catch (cause) {
    if (cause?.code !== 'E_ARGUMENT' || !ownerArgs.includes('--json')) throw cause;
    result = await commandEntry(ownerArgs.filter(argument => argument !== '--json'), ctx);
  }
  if (result && typeof result === 'object' && Number.isInteger(result.exitCode) && typeof result.output === 'string') {
    if (result.output) console.log(result.output);
    process.exitCode = result.exitCode;
  } else if (result !== undefined) output(result);
}

/** @param {string} action @param {{paths:any,env:any,config:any,dependencies?:{plan?:boolean}}} options */
export async function installedSyncSchedule(action, { paths, env, config: cfg, dependencies = {} }) {
  let current;
  try { current = await readCurrent(paths); } catch { return null; }
  const releaseDir = currentReleaseDir(paths, current);
  if (!releaseDir) return null;
  let manifest;
  const syncModuleName = ['sync', 'engine'].join('-');
  try { manifest = (await discoverModules(releaseDir)).find(item => item.name === syncModuleName); }
  catch { return null; }
  if (!manifest) return null;
  const entry = await loadInstalledModuleEntry(releaseDir, manifest);
  const entries = new Map([[manifest.name, entry]]);
  const ctx = moduleContext(cfg, paths, env, entries, [manifest], dependencies);
  await entry.activate(ctx);
  if (typeof entry.commands?.sync !== 'function') return null;
  return entry.commands.sync(['schedule', action, ...(action === 'remove' && dependencies.plan ? ['--plan'] : [])], ctx);
}
