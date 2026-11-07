// SPDX-License-Identifier: MIT
import { NotImplementedError } from '../util/errors.mjs';
/** @param {Array<object>} pages @param {{now?:Date}} options */
export function buildIndex(pages, options = {}) { throw new NotImplementedError('retrieval.buildIndex'); }
/** @param {object} index @param {string} query @param {{limit?:number,budgetChars?:number,asOf?:Date,abstainThreshold?:number}} options */
export function search(index, query, options = {}) { throw new NotImplementedError('retrieval.search'); }
/** @param {{vaultDir:string,stateDir:string,now?:Date}} options */
export function createSearcher(options) { throw new NotImplementedError('retrieval.createSearcher'); }
/** @param {string} s */
export function normalizeText(s) { throw new NotImplementedError('retrieval.normalizeText'); }
/** @param {string} token */
export function stem(token) { throw new NotImplementedError('retrieval.stem'); }

