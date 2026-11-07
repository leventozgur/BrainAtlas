// SPDX-License-Identifier: MIT
import { NotImplementedError } from '../util/errors.mjs';
/** @typedef {{dataDir:string,configFile:string,stateDir:string,installManifest:string,releasesDir?:string,currentDir?:string,binPath?:string}} ResolvedPaths */
/** @param {{platform?:string,env:Record<string,string|undefined>}} options @returns {ResolvedPaths} */
export function resolvePaths(options) { throw new NotImplementedError('paths.resolvePaths'); }
/** @param {string} absPath @returns {string} */
export function vaultId(absPath) { throw new NotImplementedError('paths.vaultId'); }

