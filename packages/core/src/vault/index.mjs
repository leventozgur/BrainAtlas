// SPDX-License-Identifier: MIT
import { NotImplementedError } from '../util/errors.mjs';
/** @param {string} dir @param {{now?:Date}} options */
export async function initVault(dir, options = {}) { throw new NotImplementedError('vault.initVault'); }
/** @param {string} text @returns {{data:object,body:string,errors:Array<object>}} */
export function parseFrontmatter(text) { throw new NotImplementedError('vault.parseFrontmatter'); }
/** @param {string} vaultDir @param {string} rel */
export async function readPage(vaultDir, rel) { throw new NotImplementedError('vault.readPage'); }
/** @param {string} vaultDir */
export async function listPages(vaultDir) { throw new NotImplementedError('vault.listPages'); }
/** @param {string} vaultDir @param {object} entry @param {{now?:Date}} options */
export async function appendLog(vaultDir, entry, options = {}) { throw new NotImplementedError('vault.appendLog'); }
/** @param {string} vaultDir @param {object} entry */
export async function upsertIndexEntry(vaultDir, entry) { throw new NotImplementedError('vault.upsertIndexEntry'); }

