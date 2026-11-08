// SPDX-License-Identifier: MIT
import { createHash } from 'node:crypto';
import { BrainAtlasError } from '../../../packages/core/src/util/errors.mjs';

/** @typedef {{path:string,rev:string,size:number}} ObjectInfo */
/** @typedef {{bytes:Uint8Array,rev:string}} StoredObject */
/** @typedef {{list(prefix:string):Promise<ObjectInfo[]>,get(path:string):Promise<StoredObject|null>,put(path:string,bytes:Uint8Array,options:{ifRev?:string,ifAbsent?:boolean}):Promise<{rev:string}>,delete(path:string,options:{ifRev:string}):Promise<void>,capabilities:{cas:boolean,mode:'object'|'git'}} ObjectTransport */

const clone = (bytes) => Uint8Array.from(bytes);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

export class SyncTransportError extends BrainAtlasError {
  constructor(code) {
    const messages = {
      E_AUTH: 'Transport authentication failed.', E_NETWORK: 'Transport is unavailable.',
      E_CONFLICT: 'Transport revision conflict.', E_QUOTA: 'Transport quota exceeded.',
      E_NOT_FOUND: 'Transport object was not found.', E_DEGRADED: 'Transport is degraded.',
      E_INTERRUPTED: 'Transport operation was interrupted.', E_INVALID_PATH: 'Transport path is invalid.',
    };
    super(code, messages[code] ?? 'Transport operation failed.');
    this.name = code === 'E_CONFLICT' ? 'ConflictError' : 'SyncTransportError';
  }
}

export class ConflictError extends SyncTransportError {
  constructor() { super('E_CONFLICT'); this.name = 'ConflictError'; }
}

export function validateTransportPath(path) {
  if (typeof path !== 'string' || !path || path.startsWith('/') || path.includes('\\') || path.includes('\0')
      || path.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new SyncTransportError('E_INVALID_PATH');
  }
  return path;
}

/**
 * An offline object transport with CAS revisions. Failure rules are consumed once;
 * `{failures:[{type:'network'|'conflict'|'quota'|'interruption', operation:'put', after:1}]}`
 * fails the matching operation after `after` successful matching calls. `interruptAfter`
 * limits total transport calls and is useful for crash recovery tests.
 * @returns {ObjectTransport & {injectFailure:Function,inspect:Function}}
 */
export function createMemoryTransport() {
  const options = arguments[0] ?? {};
  const objects = new Map();
  const failures = (options.failures ?? []).map((row) => typeof row === 'string' ? { type: row, operation: '*', after: 0 } : {
    type: row.type, operation: row.operation ?? '*', after: row.after ?? 0, seen: 0,
  });
  let revision = 0;
  let calls = 0;
  const capabilities = Object.freeze({ cas: true, mode: 'object' });
  const failureCode = (type) => ({ network: 'E_NETWORK', conflict: 'E_CONFLICT', quota: 'E_QUOTA', interruption: 'E_INTERRUPTED', interrupted: 'E_INTERRUPTED' })[type] ?? type;
  function before(operation) {
    if (Number.isSafeInteger(options.interruptAfter) && calls >= options.interruptAfter) throw new SyncTransportError('E_INTERRUPTED');
    calls += 1;
    const index = failures.findIndex((rule) => (rule.operation === '*' || rule.operation === operation) && rule.seen++ >= rule.after);
    if (index >= 0) throw new SyncTransportError(failureCode(failures.splice(index, 1)[0].type));
  }
  return {
    capabilities,
    async list(prefix = '') {
      before('list');
      if (prefix && typeof prefix !== 'string') throw new SyncTransportError('E_INVALID_PATH');
      if (prefix) {
        const trimmed = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
        validateTransportPath(trimmed);
        if (prefix.includes('//')) throw new SyncTransportError('E_INVALID_PATH');
      }
      return [...objects.entries()].filter(([path]) => path.startsWith(prefix))
        .map(([path, row]) => ({ path, rev: row.rev, size: row.bytes.byteLength }))
        .sort((a, b) => a.path.localeCompare(b.path));
    },
    async get(path) {
      before('get'); validateTransportPath(path);
      const row = objects.get(path);
      return row ? { bytes: clone(row.bytes), rev: row.rev } : null;
    },
    async put(path, bytes, putOptions = {}) {
      before('put'); validateTransportPath(path);
      if (!(bytes instanceof Uint8Array)) throw new TypeError('Transport bytes must be a Uint8Array.');
      if (putOptions.ifAbsent === true && putOptions.ifRev !== undefined) throw new SyncTransportError('E_CONFLICT');
      const current = objects.get(path);
      if (putOptions.ifAbsent && current) throw new ConflictError();
      if (putOptions.ifRev !== undefined && (!current || current.rev !== putOptions.ifRev)) throw new ConflictError();
      if (!putOptions.ifAbsent && putOptions.ifRev === undefined && current) throw new ConflictError();
      revision += 1;
      const rev = `${revision}-${digest(bytes).slice(0, 12)}`;
      objects.set(path, { bytes: clone(bytes), rev });
      return { rev };
    },
    async delete(path, deleteOptions = {}) {
      before('delete'); validateTransportPath(path);
      const current = objects.get(path);
      if (!current) throw new SyncTransportError('E_NOT_FOUND');
      if (!deleteOptions.ifRev || current.rev !== deleteOptions.ifRev) throw new ConflictError();
      objects.delete(path);
    },
    async injectFailure(rule, ruleOptions = {}) {
      const row = typeof rule === 'string' ? { type: rule, ...ruleOptions } : rule;
      if (!row || typeof row.type !== 'string') throw new TypeError('Failure type is required.');
      failures.push({ type: row.type, operation: row.operation ?? '*', after: row.after ?? 0, seen: 0 });
    },
    async inspect(path) {
      validateTransportPath(path);
      const row = objects.get(path);
      return row ? { bytes: clone(row.bytes), rev: row.rev } : null;
    },
  };
}
