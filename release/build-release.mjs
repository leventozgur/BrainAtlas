// SPDX-License-Identifier: MIT
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { NotImplementedError } from '@brainatlas/core';
/** @param {{version:string,profile:'lite'|'full',modules:string[],builtAt:string}} options @returns {Promise<string[]>} */
export async function buildRelease(options) { throw new NotImplementedError('release.buildRelease'); }
/** @param {string} archivePath @param {string} checksumPath @param {string} signaturePath @returns {Promise<object>} */
export async function verifyRelease(archivePath, checksumPath, signaturePath) { throw new NotImplementedError('release.verifyRelease'); }
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.error('not implemented');
  process.exitCode = 2;
}
