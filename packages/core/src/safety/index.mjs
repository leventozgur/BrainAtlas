// SPDX-License-Identifier: MIT
import { NotImplementedError } from '../util/errors.mjs';
/** @param {string} text @param {{rules?:object[]}} options */
export function scanText(text, options = {}) { throw new NotImplementedError('safety.scanText'); }
/** @param {string} relPath @param {{denyGlobs?:string[]}} options */
export function scanPath(relPath, options = {}) { throw new NotImplementedError('safety.scanPath'); }
/** @param {string} text @param {{rules?:object[]}} options */
export function redact(text, options = {}) { throw new NotImplementedError('safety.redact'); }

