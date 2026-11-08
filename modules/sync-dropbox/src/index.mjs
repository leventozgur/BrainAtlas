// SPDX-License-Identifier: MIT
import { BrainAtlasError } from '../../../packages/core/src/util/errors.mjs';
import { createCredentialStore } from './credentials.mjs';
import { DropboxError } from './errors.mjs';
import { createDropboxTokenProvider, enrollDropbox } from './oauth.mjs';
import { createDropboxTransport } from './transport.mjs';

function storeFor(ctx) {
  return ctx?.credentialStore ?? ctx?.dropbox?.credentialStore ?? createCredentialStore({
    platform: ctx?.env?.BRAINATLAS_PLATFORM || process.platform,
    runCommand: ctx?.runCommand ?? ctx?.dropbox?.runCommand,
  });
}

function fetchFor(ctx) { return ctx?.fetch ?? ctx?.dropbox?.fetch ?? globalThis.fetch; }

/** Attach the Dropbox transport when the active config selects it. */
export async function activate(ctx) {
  if (!ctx || typeof ctx !== 'object' || !ctx.config || !ctx.paths) throw new BrainAtlasError('E_MODULE_CONTEXT', 'Dropbox module context is incomplete.');
  if (ctx.config.sync?.transport !== 'dropbox' || ctx.transport) return;
  const credentialStore = storeFor(ctx);
  const fetchImpl = fetchFor(ctx);
  const getAccessToken = createDropboxTokenProvider({ credentialStore, fetch: fetchImpl });
  ctx.transport = createDropboxTransport({
    fetch: fetchImpl,
    getAccessToken,
    root: ctx.config.sync?.options?.root ?? '/BrainAtlas',
  });
}

function enrollmentArgs(args = {}) {
  const values = Array.isArray(args) ? args.slice() : typeof args === 'string' ? args.split(/\s+/) : [];
  if (values[0] === 'dropbox') values.shift();
  let action = Array.isArray(args) || typeof args === 'string' ? values.shift() : args?.action ?? args?.subcommand;
  if (action === undefined) action = args?.command;
  let appKey = Array.isArray(args) || typeof args === 'string' ? undefined : args?.appKey ?? args?.['--app-key'];
  if (Array.isArray(args) || typeof args === 'string') {
    for (let index = 0; index < values.length; index += 1) {
      const item = values[index];
      if (item === '--app-key') { appKey = values[index + 1]; index += 1; }
      else if (typeof item === 'string' && item.startsWith('--app-key=')) appKey = item.slice('--app-key='.length);
    }
  }
  return { action, appKey };
}

async function dispatchDropbox(args, ctx) {
  if (!ctx || typeof ctx !== 'object') throw new BrainAtlasError('E_MODULE_CONTEXT', 'Dropbox command context is incomplete.');
  const { action, appKey } = enrollmentArgs(args);
  if (action !== 'enroll') throw new BrainAtlasError('E_ARGUMENT', 'Unknown Dropbox command.');
  return enrollDropbox({
    appKey,
    fetch: fetchFor(ctx),
    credentialStore: storeFor(ctx),
    stdin: ctx.stdin ?? process.stdin,
    stdout: ctx.stdout ?? process.stdout,
  });
}

export const commands = Object.freeze({
  dropbox: (args, ctx) => dispatchDropbox(args, ctx),
  // Kept as an alias for hosts that dispatch the nested sync command directly.
  sync: async (args, ctx) => {
    const values = Array.isArray(args) ? args : [];
    if (values[0] !== 'dropbox') throw new DropboxError('E_ARGUMENT');
    return dispatchDropbox(values, ctx);
  },
});

export { DropboxError, createCredentialStore, createDropboxTokenProvider, enrollDropbox, createDropboxTransport };
