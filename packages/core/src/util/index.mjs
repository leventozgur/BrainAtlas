// SPDX-License-Identifier: MIT
import { NotImplementedError, BrainAtlasError } from './errors.mjs';
export { NotImplementedError, BrainAtlasError };
/** @param {string} file @param {string|Uint8Array} data @param {{mode?:number}} options */
export async function atomicWriteFile(file, data, options = {}) { throw new NotImplementedError('util.atomicWriteFile'); }
/** @param {string} root @param {string} rel */
export function safeJoin(root, rel) { throw new NotImplementedError('util.safeJoin'); }
/** @param {string} cmd @param {string[]} args @param {{cwd:string,env?:object,timeoutMs?:number}} options */
export async function runCommand(cmd, args, options) { throw new NotImplementedError('util.runCommand'); }

