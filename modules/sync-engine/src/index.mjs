// SPDX-License-Identifier: MIT
import { BrainAtlasError } from '../../../packages/core/src/util/errors.mjs';
import { createSyncEngine, classifySyncError, SYNC_ERROR_CODES } from './engine.mjs';
import { createMemoryTransport, SyncTransportError, ConflictError } from './transport.mjs';
import { planScheduler, planSchedulerUninstall } from './scheduler.mjs';
import { mergeCanonicalPath, mergeIndexThreeWay, mergeLogThreeWay } from './merge.mjs';
import { inventoryVault, resolveSyncScope, globMatch } from './scope.mjs';

function engineFor(ctx = {}) {
  const vaultPath = ctx.config?.vault?.path;
  const stateDir = ctx.paths?.stateDir;
  if (typeof vaultPath !== 'string' || typeof stateDir !== 'string') throw new BrainAtlasError('E_MODULE_CONTEXT', 'Sync context is incomplete.');
  const transport = ctx.transport ?? ctx.core?.syncTransport ?? ctx.core?.transport ?? ctx.config?.sync?.options?.transport;
  return createSyncEngine({ vaultPath, stateDir, config: ctx.config, transport, hostId: ctx.hostId ?? ctx.env?.BRAINATLAS_HOST_ID, logger: ctx.logger });
}

function actionFrom(args) {
  if (typeof args === 'string') return args;
  if (Array.isArray(args)) return args[0];
  return args?.action ?? args?.subcommand ?? args?.command ?? args?.[0];
}

async function dispatch(ctx, args = {}) {
  const action = actionFrom(args);
  const engine = engineFor(ctx);
  if (action === 'status') return engine.status();
  if (action === 'run') return engine.run();
  if (action === 'check') {
    const positional = Array.isArray(args) ? args.slice(1) : (args.positionals ?? args.args ?? []);
    const peer = Array.isArray(args) ? args[1] : (args.peer ?? args['--peer'] ?? positional[0]);
    return engine.checkPeer(peer);
  }
  if (action === 'approve') {
    const positional = Array.isArray(args) ? args.slice(1) : (args.positionals ?? args.args ?? []);
    const paths = Array.isArray(args) ? positional : (args.paths ?? (args.path ? [args.path] : positional));
    return engine.approveDeletes(paths);
  }
  if (action === 'pause') return engine.pause();
  if (action === 'resume') return engine.resume();
  throw new BrainAtlasError('E_ARGUMENT', 'Unknown sync command.');
}

export async function activate(ctx) {
  if (!ctx || !ctx.config || !ctx.paths) throw new BrainAtlasError('E_MODULE_CONTEXT', 'Sync module context is incomplete.');
  return;
}

export const commands = Object.freeze({
  sync: dispatch,
  status: (ctx) => dispatch(ctx, { action: 'status' }),
  run: (ctx) => dispatch(ctx, { action: 'run' }),
  check: (ctx, args) => dispatch(ctx, Array.isArray(args) ? ['check', ...args] : { ...args, action: 'check' }),
  approve: (ctx, args) => dispatch(ctx, Array.isArray(args) ? ['approve', ...args] : { ...args, action: 'approve' }),
  pause: (ctx) => dispatch(ctx, { action: 'pause' }),
  resume: (ctx) => dispatch(ctx, { action: 'resume' }),
});

export { createSyncEngine, classifySyncError, SYNC_ERROR_CODES, createMemoryTransport, SyncTransportError, ConflictError,
  planScheduler, planSchedulerUninstall, mergeCanonicalPath, mergeIndexThreeWay, mergeLogThreeWay,
  inventoryVault, resolveSyncScope, globMatch };
