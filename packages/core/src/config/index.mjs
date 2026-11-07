// SPDX-License-Identifier: MIT
import { mkdir, readFile, rename, writeFile, copyFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import { BrainAtlasError } from '../util/errors.mjs';

/** @typedef {{schemaVersion:1,profile:'lite'|'full'|'custom',vault:{path:string},modules:string[],agents:string[],scope:'global'|'vault',retrieval:{budgetChars:number,abstainThreshold:number},hooks:{mode:'normal'|'economic'|'manual',deadlineMs:number},safety:{secretFilter:true,extraDenyGlobs:string[]},okf:{level:'warn'|'strict'},sync:{transport:string|null,options:object},telemetry:false,readOnly:boolean,node:{path:string}}} Config */

/** @type {object} */
export const CONFIG_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', additionalProperties: false,
  required: ['schemaVersion','profile','vault','modules','agents','scope','retrieval','hooks','safety','okf','sync','telemetry','readOnly','node'],
  properties: {
    schemaVersion: { type: 'integer', enum: [1] }, profile: { type: 'string', enum: ['lite','full','custom'] },
    vault: { type: 'object', required: ['path'], properties: { path: { type: 'string', minLength: 1 } }, additionalProperties: false },
    modules: { type: 'array', items: { type: 'string', minLength: 1 }, uniqueItems: true }, agents: { type: 'array', items: { type: 'string', minLength: 1 }, uniqueItems: true },
    scope: { type: 'string', enum: ['global','vault'] },
    retrieval: { type: 'object', required: ['budgetChars','abstainThreshold'], properties: { budgetChars: { type: 'integer', minimum: 1 }, abstainThreshold: { type: 'number', minimum: 0, maximum: 1 } }, additionalProperties: false },
    hooks: { type: 'object', required: ['mode','deadlineMs'], properties: { mode: { type: 'string', enum: ['normal','economic','manual'] }, deadlineMs: { type: 'integer', minimum: 1 } }, additionalProperties: false },
    safety: { type: 'object', required: ['secretFilter','extraDenyGlobs'], properties: { secretFilter: { const: true }, extraDenyGlobs: { type: 'array', items: { type: 'string' } } }, additionalProperties: false },
    okf: { type: 'object', required: ['level'], properties: { level: { type: 'string', enum: ['warn','strict'] } }, additionalProperties: false },
    sync: { type: 'object', required: ['transport','options'], properties: { transport: { type: ['string','null'] }, options: { type: 'object' } }, additionalProperties: false },
    telemetry: { const: false }, readOnly: { type: 'boolean' }, node: { type: 'object', required: ['path'], properties: { path: { type: 'string' } }, additionalProperties: false }
  }
};

export const PROFILES = Object.freeze({
  lite: Object.freeze({ modules: Object.freeze([]), lockedKeys: Object.freeze(['telemetry','safety.secretFilter']) }),
  full: Object.freeze({ modules: Object.freeze(['*']), lockedKeys: Object.freeze(['safety.secretFilter']) }),
  custom: Object.freeze({ modules: Object.freeze([]), lockedKeys: Object.freeze([]) })
});

const clone = (value) => structuredClone(value);
const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const pathName = (path) => path || '$';
function error(path, code, message) { return { path: pathName(path), code, message }; }

/** Small dependency-free validator for the schema keywords used by CONFIG_SCHEMA. */
function validateSchema(value, schema, path, errors) {
  if (has(schema, 'const') && value !== schema.const) errors.push(error(path, 'E_CONST', `Invalid value for ${pathName(path)}.`));
  if (schema.enum && !schema.enum.includes(value)) errors.push(error(path, 'E_ENUM', `Invalid value for ${pathName(path)}.`));
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const matches = types.some((type) => type === 'null' ? value === null : type === 'array' ? Array.isArray(value) : type === 'integer' ? Number.isInteger(value) : type === 'number' ? typeof value === 'number' && Number.isFinite(value) : type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value) : typeof value === type);
    if (!matches) { errors.push(error(path, 'E_TYPE', `Invalid type for ${pathName(path)}.`)); return; }
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(error(path, 'E_MINIMUM', `${pathName(path)} is below its minimum.`));
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(error(path, 'E_MAXIMUM', `${pathName(path)} is above its maximum.`));
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(error(path, 'E_MIN_LENGTH', `${pathName(path)} is too short.`));
    if (schema.pattern && !(new RegExp(schema.pattern).test(value))) errors.push(error(path, 'E_PATTERN', `${pathName(path)} has an invalid format.`));
  }
  if (Array.isArray(value)) {
    if (schema.items) value.forEach((item, index) => validateSchema(item, schema.items, `${path}[${index}]`, errors));
    if (schema.uniqueItems) for (let i = 0; i < value.length; i++) for (let j = 0; j < i; j++) if (JSON.stringify(value[i]) === JSON.stringify(value[j])) { errors.push(error(path, 'E_UNIQUE', `${pathName(path)} contains duplicate items.`)); return; }
  }
  if (value && typeof value === 'object' && !Array.isArray(value) && schema.properties) {
    for (const key of schema.required || []) if (!has(value, key)) errors.push(error(path ? `${path}.${key}` : key, 'E_REQUIRED', `Missing required key ${path ? `${path}.` : ''}${key}.`));
    for (const key of Object.keys(value)) {
      if (!has(schema.properties, key)) { if (schema.additionalProperties === false) errors.push(error(path ? `${path}.${key}` : key, 'E_ADDITIONAL_PROPERTY', `Unknown key ${path ? `${path}.` : ''}${key}.`)); }
      else validateSchema(value[key], schema.properties[key], path ? `${path}.${key}` : key, errors);
    }
  }
}

/** @param {'lite'|'full'|'custom'} profile @returns {Config} */
export function defaultConfig(profile) {
  if (!has(PROFILES, profile)) throw new BrainAtlasError('E_PROFILE', 'Unknown configuration profile.');
  return { schemaVersion: 1, profile, vault: { path: '.' }, modules: [...PROFILES[profile].modules], agents: [], scope: 'global', retrieval: { budgetChars: 4000, abstainThreshold: 0.35 }, hooks: { mode: 'normal', deadlineMs: 1000 }, safety: { secretFilter: true, extraDenyGlobs: [] }, okf: { level: 'warn' }, sync: { transport: null, options: {} }, telemetry: false, readOnly: false, node: { path: 'node' } };
}

/** @param {unknown} obj @returns {{ok:boolean, errors:Array<{path:string,code:string,message:string}>}} */
export function validateConfig(obj) {
  const errors = [];
  validateSchema(obj, CONFIG_SCHEMA, '', errors);
  if (obj && typeof obj === 'object' && !Array.isArray(obj) && obj.safety && typeof obj.safety === 'object' && obj.safety.secretFilter === false) errors.push(error('safety.secretFilter', 'E_LOCKED_KEY', 'safety.secretFilter cannot be disabled.'));
  return { ok: errors.length === 0, errors };
}

/** @param {{paths:object,env:Record<string,string|undefined>}} options @returns {Promise<Config>} */
export async function loadConfig(options) {
  const { paths, env = {} } = options || {};
  if (!paths?.configFile) throw new BrainAtlasError('E_PATHS', 'Configuration file path is required.');
  let text;
  try { text = await readFile(paths.configFile, 'utf8'); } catch (cause) { if (cause?.code === 'ENOENT') return defaultConfig(env.BRAINATLAS_PROFILE || 'lite'); throw new BrainAtlasError('E_CONFIG_READ', 'Could not read configuration.'); }
  let value;
  try { value = JSON.parse(text); } catch { throw new BrainAtlasError('E_CONFIG_PARSE', 'Configuration file is not valid JSON.'); }
  if (!Number.isInteger(value?.schemaVersion) || value.schemaVersion < 1) {
    const migrated = await migrateConfig(text, { backupDir: dirname(paths.configFile) });
    value = migrated.config;
    if (migrated.applied.length) await saveConfig(value, { paths });
  }
  const result = validateConfig(value);
  if (!result.ok) throw new BrainAtlasError('E_CONFIG_INVALID', 'Configuration is invalid.', result.errors);
  return value;
}

/** @param {Config} cfg @param {{paths:object}} options @returns {Promise<void>} */
export async function saveConfig(cfg, options) {
  const { paths } = options || {};
  const result = validateConfig(cfg);
  if (!result.ok) throw new BrainAtlasError('E_CONFIG_INVALID', 'Configuration is invalid.', result.errors);
  const file = paths?.configFile;
  if (typeof file !== 'string' || !isAbsolute(file) || file.split(/[\\/]/).includes('..') || normalize(file) !== file) throw new BrainAtlasError('E_PATH_ESCAPE', 'Configuration file path is invalid.');
  const dir = dirname(file);
  const tmp = join(dir, `.config-${process.pid}-${Date.now()}.tmp`);
  await mkdir(dir, { recursive: true });
  try { await writeFile(tmp, `${JSON.stringify(cfg, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); await rename(tmp, file); }
  catch { try { const { unlink } = await import('node:fs/promises'); await unlink(tmp); } catch {} throw new BrainAtlasError('E_CONFIG_WRITE', 'Could not save configuration.'); }
}

/** @param {Config} cfg @param {string} dottedKey @param {unknown} value @returns {Config} */
export function setConfigValue(cfg, dottedKey, value) {
  if (!cfg || !has(PROFILES, cfg.profile) || typeof dottedKey !== 'string' || !dottedKey) throw new BrainAtlasError('E_CONFIG_KEY', 'Invalid configuration key.');
  const lockedValue = dottedKey === 'safety.secretFilter' ? true : dottedKey === 'telemetry' ? false : undefined;
  if (PROFILES[cfg.profile].lockedKeys.includes(dottedKey) && value !== lockedValue) throw new BrainAtlasError('E_LOCKED_KEY', `Configuration key ${dottedKey} is locked for this profile.`);
  if (dottedKey === 'safety.secretFilter' && value === false) throw new BrainAtlasError('E_LOCKED_KEY', 'safety.secretFilter cannot be disabled.');
  const keys = dottedKey.split('.');
  if (keys.some((key) => !key) || keys.length > 2) throw new BrainAtlasError('E_CONFIG_KEY', 'Invalid configuration key.');
  const out = clone(cfg); let target = out;
  for (const key of keys.slice(0, -1)) { if (!target[key] || typeof target[key] !== 'object' || Array.isArray(target[key])) throw new BrainAtlasError('E_CONFIG_KEY', `Unknown configuration key ${dottedKey}.`); target = target[key]; }
  if (!has(target, keys.at(-1))) throw new BrainAtlasError('E_CONFIG_KEY', `Unknown configuration key ${dottedKey}.`);
  target[keys.at(-1)] = clone(value);
  const result = validateConfig(out);
  if (!result.ok) throw new BrainAtlasError('E_CONFIG_INVALID', 'Configuration is invalid.', result.errors);
  return out;
}

/** @param {unknown| string} objOrText @param {{backupDir:string,now?:Date,sourceText?:string,migrations?:Array<{from:number,to:number,migrate:(obj:object)=>object}>}} options @returns {Promise<{config:Config,applied:string[],backupPath:string|null}>} */
export async function migrateConfig(objOrText, options = {}) {
  const { backupDir, now = new Date(), sourceText, migrations } = options;
  let obj = objOrText;
  if (typeof objOrText === 'string') {
    try { obj = JSON.parse(objOrText); } catch { throw new BrainAtlasError('E_CONFIG_PARSE', 'Configuration file is not valid JSON.'); }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new BrainAtlasError('E_CONFIG_INVALID', 'Configuration is invalid.');
  const migration = (await import('./migrations/000-to-1.mjs')).default;
  const chain = migrations || [migration];
  let current = clone(obj); const applied = [];
  let version = Number.isInteger(current?.schemaVersion) ? current.schemaVersion : 0;
  while (version < 1) {
    const migration = chain.find((item) => item.from === version);
    if (!migration || migration.to <= version) throw new BrainAtlasError('E_MIGRATION_MISSING', `No configuration migration from version ${version}.`);
    current = await migration.migrate(clone(current));
    version = migration.to; current.schemaVersion = version; applied.push(`${String(migration.from).padStart(3, '0')}-to-${migration.to}`);
  }
  const validation = validateConfig(current);
  if (!validation.ok) throw new BrainAtlasError('E_CONFIG_INVALID', 'Migrated configuration is invalid.', validation.errors);
  if (!applied.length) return { config: current, applied, backupPath: null };
  if (!backupDir) throw new BrainAtlasError('E_BACKUP_DIR', 'A backup directory is required for migration.');
  await mkdir(backupDir, { recursive: true });
  const backupPath = join(backupDir, `config.json.bak.${now.toISOString()}`);
  // In-memory callers have no original bytes; retain the compact JSON serialization plus its line ending.
  const backupText = sourceText ?? (typeof objOrText === 'string' ? objOrText : `${JSON.stringify(obj)}\n`);
  await writeFile(backupPath, backupText, { flag: 'wx', mode: 0o600 });
  return { config: current, applied, backupPath };
}
