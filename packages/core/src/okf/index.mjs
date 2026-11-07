// SPDX-License-Identifier: MIT
import { NotImplementedError } from '../util/errors.mjs';
/** @param {object} page @param {{asOf?:Date,level?:'warn'|'strict'}} options */
export function checkPage(page, options = {}) { throw new NotImplementedError('okf.checkPage'); }
/** @param {string} vaultDir @param {{asOf?:Date,level?:'warn'|'strict',changed?:string[]}} options */
export async function checkVault(vaultDir, options = {}) { throw new NotImplementedError('okf.checkVault'); }

