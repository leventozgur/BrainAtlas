// SPDX-License-Identifier: MIT
import { NotImplementedError } from '../util/errors.mjs';
/** @typedef {{schemaVersion:1,profile:'lite'|'full'|'custom',vault:{path:string},modules:string[],agents:string[],scope:'global'|'vault',retrieval:{budgetChars:number,abstainThreshold:number},hooks:{mode:'normal'|'economic'|'manual',deadlineMs:number},safety:{secretFilter:true,extraDenyGlobs:string[]},okf:{level:'warn'|'strict'},sync:{transport:string|null,options:object},telemetry:false,readOnly:boolean,node:{path:string}}} Config */
/** @type {object} */
export const CONFIG_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object', additionalProperties: false,
  required: ['schemaVersion','profile','vault','modules','agents','scope','retrieval','hooks','safety','okf','sync','telemetry','readOnly','node'],
  properties: {
    schemaVersion: { const: 1 }, profile: { enum: ['lite','full','custom'] },
    vault: { type: 'object', required: ['path'], properties: { path: { type: 'string', minLength: 1 } }, additionalProperties: false },
    modules: { type: 'array', items: { type: 'string' }, uniqueItems: true }, agents: { type: 'array', items: { type: 'string' }, uniqueItems: true },
    scope: { enum: ['global','vault'] },
    retrieval: { type: 'object', required: ['budgetChars','abstainThreshold'], properties: { budgetChars: { type: 'integer', minimum: 1 }, abstainThreshold: { type: 'number', minimum: 0, maximum: 1 } }, additionalProperties: false },
    hooks: { type: 'object', required: ['mode','deadlineMs'], properties: { mode: { enum: ['normal','economic','manual'] }, deadlineMs: { type: 'integer', minimum: 1 } }, additionalProperties: false },
    safety: { type: 'object', required: ['secretFilter','extraDenyGlobs'], properties: { secretFilter: { const: true }, extraDenyGlobs: { type: 'array', items: { type: 'string' } } }, additionalProperties: false },
    okf: { type: 'object', required: ['level'], properties: { level: { enum: ['warn','strict'] } }, additionalProperties: false },
    sync: { type: 'object', required: ['transport','options'], properties: { transport: { type: ['string','null'] }, options: { type: 'object' } }, additionalProperties: false },
    telemetry: { const: false }, readOnly: { type: 'boolean' }, node: { type: 'object', required: ['path'], properties: { path: { type: 'string' } }, additionalProperties: false }
  }
};
export const PROFILES = Object.freeze({
  // Lite ships no optional modules. Full = every module discovered in the release whose module.json
  // lists 'full' in `profiles` ('*' marker); core never hard-codes optional module names (Lite purity).
  lite: { modules: [], lockedKeys: ['telemetry','safety.secretFilter'] },
  full: { modules: ['*'], lockedKeys: ['safety.secretFilter'] },
  custom: { modules: [], lockedKeys: [] }
});
/** @param {'lite'|'full'|'custom'} profile @returns {Config} */
export function defaultConfig(profile) { throw new NotImplementedError('config.defaultConfig'); }
/** @param {unknown} obj @returns {{ok:boolean, errors:Array<{path:string,code:string,message:string}>}} */
export function validateConfig(obj) { throw new NotImplementedError('config.validateConfig'); }
/** @param {{paths:object, env:object}} options @returns {Promise<object>} */
export async function loadConfig(options) { throw new NotImplementedError('config.loadConfig'); }
/** @param {object} cfg @param {{paths:object}} options @returns {Promise<void>} */
export async function saveConfig(cfg, options) { throw new NotImplementedError('config.saveConfig'); }
/** @param {object} cfg @param {string} dottedKey @param {unknown} value @returns {object} */
export function setConfigValue(cfg, dottedKey, value) { throw new NotImplementedError('config.setConfigValue'); }
/** @param {object} obj @param {{backupDir:string, now?:Date}} options @returns {Promise<{config:object,applied:string[],backupPath:string|null}>} */
export async function migrateConfig(obj, options) { throw new NotImplementedError('config.migrateConfig'); }

