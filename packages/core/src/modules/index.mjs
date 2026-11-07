// SPDX-License-Identifier: MIT
import { NotImplementedError } from '../util/errors.mjs';
/** @typedef {{name:string,version:string,description:string,requires:string[],provides:string[],profiles:Array<'lite'|'full'|'custom'>,entry:string,experimental?:boolean}} ModuleManifest */
/** @param {string} dir @returns {ModuleManifest} */
export function readModuleManifest(dir) { throw new NotImplementedError('modules.readModuleManifest'); }
/** @param {string} releaseDir @returns {Promise<ModuleManifest[]>} */
export async function discoverModules(releaseDir) { throw new NotImplementedError('modules.discoverModules'); }
/** @param {ModuleManifest[]} manifests @returns {ModuleManifest[]} */
export function resolveModuleOrder(manifests) { throw new NotImplementedError('modules.resolveModuleOrder'); }

