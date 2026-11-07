// SPDX-License-Identifier: MIT
import { NotImplementedError } from '@brainatlas/core';
/** @typedef {{path:string,rev:string,size:number}} ObjectInfo */
/** @typedef {{bytes:Uint8Array,rev:string}} StoredObject */
/** @typedef {{list(prefix:string):Promise<ObjectInfo[]>,get(path:string):Promise<StoredObject|null>,put(path:string,bytes:Uint8Array,options:{ifRev?:string,ifAbsent?:boolean}):Promise<{rev:string}>,delete(path:string,options:{ifRev:string}):Promise<void>,capabilities:{cas:boolean,mode:'object'|'git'}} ObjectTransport */
/** @returns {ObjectTransport} */
export function createMemoryTransport() { throw new NotImplementedError('transport.createMemoryTransport'); }
