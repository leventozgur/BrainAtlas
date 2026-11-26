// SPDX-License-Identifier: MIT
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { BrainAtlasError } from '../util/errors.mjs';
import { atomicWriteFile } from '../util/index.mjs';

export const STANDARD_VERSION = 1;

export const STANDARD_SCHEMA = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['standardVersion', 'okf', 'retrieval', 'safety', 'capabilities'],
  properties: {
    standardVersion: { type: 'integer', minimum: 1 },
    okf: {
      type: 'object',
      additionalProperties: false,
      required: ['level'],
      properties: { level: { type: 'string', enum: ['warn', 'strict'] } },
    },
    retrieval: {
      type: 'object',
      additionalProperties: false,
      required: ['budgetChars', 'abstainThreshold'],
      properties: {
        budgetChars: { type: 'integer', minimum: 1 },
        abstainThreshold: { type: 'number', minimum: 0, maximum: 1 },
        exclude: {
          type: 'array',
          items: { type: 'string', minLength: 1, maxLength: 200 },
          uniqueItems: true,
        },
      },
    },
    safety: {
      type: 'object',
      additionalProperties: false,
      required: ['extraDenyGlobs'],
      properties: { extraDenyGlobs: { type: 'array', items: { type: 'string' } } },
    },
    capabilities: {
      type: 'object',
      additionalProperties: false,
      required: ['minimum'],
      properties: {
        minimum: {
          type: 'object',
          additionalProperties: false,
          required: ['read', 'write'],
          properties: { read: { const: true }, write: { type: 'boolean' } },
        },
      },
    },
  },
});

export const VAULT_STANDARD_KEYS = Object.freeze([
  'okf.level',
  'retrieval.budgetChars',
  'retrieval.abstainThreshold',
  'retrieval.exclude',
  'safety.extraDenyGlobs',
]);

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export function isVaultStandardKey(key) {
  return VAULT_STANDARD_KEYS.includes(key);
}

function issue(path, code, message) {
  return { path: path || '$', code, message };
}

export function validateStandard(value) {
  const errors = [];
  const check = (node, schema, path) => {
    if (!schema) return;
    if (has(schema, 'const') && node !== schema.const)
      errors.push(issue(path, 'E_CONST', `Invalid value for ${path || '$'}.`));
    if (schema.enum && !schema.enum.includes(node))
      errors.push(issue(path, 'E_ENUM', `Invalid value for ${path || '$'}.`));
    if (schema.type) {
      const types = Array.isArray(schema.type) ? schema.type : [schema.type];
      const matches = types.some((type) =>
        type === 'integer'
          ? Number.isInteger(node)
          : type === 'number'
            ? typeof node === 'number' && Number.isFinite(node)
            : type === 'array'
              ? Array.isArray(node)
              : type === 'object'
                ? isObject(node)
                : typeof node === type
      );
      if (!matches) {
        errors.push(issue(path, 'E_TYPE', `Invalid type for ${path || '$'}.`));
        return;
      }
    }
    if (typeof node === 'number') {
      if (schema.minimum !== undefined && node < schema.minimum)
        errors.push(issue(path, 'E_MINIMUM', `${path} is below its minimum.`));
      if (schema.maximum !== undefined && node > schema.maximum)
        errors.push(issue(path, 'E_MAXIMUM', `${path} is above its maximum.`));
    }
    if (typeof node === 'string' && schema.minLength !== undefined && node.length < schema.minLength)
      errors.push(issue(path, 'E_MIN_LENGTH', `${path} is too short.`));
    if (typeof node === 'string' && schema.maxLength !== undefined && node.length > schema.maxLength)
      errors.push(issue(path, 'E_MAX_LENGTH', `${path} is too long.`));
    if (Array.isArray(node)) {
      if (schema.items) node.forEach((item, index) => check(item, schema.items, `${path}[${index}]`));
      if (schema.uniqueItems)
        for (let left = 0; left < node.length; left++)
          for (let right = 0; right < left; right++)
            if (JSON.stringify(node[left]) === JSON.stringify(node[right])) {
              errors.push(issue(path, 'E_UNIQUE', `${path} contains duplicate items.`));
              return;
            }
    }
    if (isObject(node) && schema.properties) {
      for (const key of schema.required || [])
        if (!has(node, key)) errors.push(issue(path ? `${path}.${key}` : key, 'E_REQUIRED', `Missing ${key}.`));
      for (const key of Object.keys(node)) {
        if (!has(schema.properties, key)) {
          if (schema.additionalProperties === false)
            errors.push(issue(path ? `${path}.${key}` : key, 'E_ADDITIONAL_PROPERTY', `Unknown key ${key}.`));
        } else check(node[key], schema.properties[key], path ? `${path}.${key}` : key);
      }
    }
  };
  check(value, STANDARD_SCHEMA, '');
  const exclude = value?.retrieval?.exclude;
  if (Array.isArray(exclude))
    exclude.forEach((pattern, index) => {
      if (
        typeof pattern === 'string' &&
        (pattern.startsWith('/') ||
          /^[A-Za-z]:/.test(pattern) ||
          pattern.includes('\\') ||
          pattern.split('/').includes('..'))
      )
        errors.push(issue(`retrieval.exclude[${index}]`, 'E_PATH_INVALID', 'Exclude patterns must stay relative.'));
    });
  return { ok: errors.length === 0, errors };
}

function inside(base, target) {
  const rel = relative(base, target);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith('/'));
}

export function standardFromConfig(cfg) {
  const retrieval = {
    budgetChars: cfg?.retrieval?.budgetChars,
    abstainThreshold: cfg?.retrieval?.abstainThreshold,
  };
  if (Array.isArray(cfg?.retrieval?.exclude)) retrieval.exclude = [...cfg.retrieval.exclude];
  return {
    standardVersion: STANDARD_VERSION,
    okf: { level: cfg?.okf?.level },
    retrieval,
    safety: { extraDenyGlobs: [...(cfg?.safety?.extraDenyGlobs || [])] },
    capabilities: { minimum: { read: true, write: cfg?.readOnly !== true } },
  };
}

export async function readStandard(vaultDir) {
  if (typeof vaultDir !== 'string' || !vaultDir)
    return { standard: null, errors: [issue('vault', 'E_STANDARD_PATH', 'A vault directory is required.')] };
  let base;
  try {
    base = await realpath(vaultDir);
  } catch (cause) {
    if (cause?.code === 'ENOENT') return { standard: null, errors: [] };
    return { standard: null, errors: [issue('vault', 'E_STANDARD_VAULT', 'The vault is not readable.')] };
  }
  const dir = join(base, '.brainatlas');
  try {
    const info = await lstat(dir);
    if (info.isSymbolicLink())
      return { standard: null, errors: [issue('.brainatlas', 'E_STANDARD_SYMLINK', 'Symbolic links are refused.')] };
    if (!info.isDirectory())
      return {
        standard: null,
        errors: [issue('.brainatlas', 'E_STANDARD_PATH', 'The standard directory is invalid.')],
      };
  } catch (cause) {
    if (cause?.code === 'ENOENT') return { standard: null, errors: [] };
    return {
      standard: null,
      errors: [issue('.brainatlas', 'E_STANDARD_READ', 'The standard directory is unreadable.')],
    };
  }
  const file = join(dir, 'standard.json');
  try {
    const info = await lstat(file);
    if (info.isSymbolicLink())
      return {
        standard: null,
        errors: [issue('.brainatlas/standard.json', 'E_STANDARD_SYMLINK', 'Symbolic links are refused.')],
      };
    if (!info.isFile())
      return {
        standard: null,
        errors: [issue('.brainatlas/standard.json', 'E_STANDARD_PATH', 'The standard file is invalid.')],
      };
  } catch (cause) {
    if (cause?.code === 'ENOENT') return { standard: null, errors: [] };
    return {
      standard: null,
      errors: [issue('.brainatlas/standard.json', 'E_STANDARD_READ', 'The standard file is unreadable.')],
    };
  }
  let value;
  try {
    value = JSON.parse(await readFile(file, 'utf8'));
  } catch (cause) {
    if (cause?.code === 'ENOENT') return { standard: null, errors: [] };
    return {
      standard: null,
      errors: [issue('.brainatlas/standard.json', 'E_STANDARD_PARSE', 'The standard file is not valid JSON.')],
    };
  }
  if (Number.isInteger(value?.standardVersion) && value.standardVersion > STANDARD_VERSION)
    return { standard: value, errors: [] };
  const result = validateStandard(value);
  if (!result.ok) return { standard: null, errors: result.errors };
  return { standard: value, errors: [] };
}

export async function writeStandard(vaultDir, standard) {
  if (typeof vaultDir !== 'string' || !vaultDir)
    throw new BrainAtlasError('E_STANDARD_PATH', 'A vault directory is required.');
  const result = validateStandard(standard);
  if (!result.ok) throw new BrainAtlasError('E_STANDARD_INVALID', 'Vault standard is invalid.', result.errors);
  let base;
  try {
    base = await realpath(vaultDir);
  } catch {
    throw new BrainAtlasError('E_STANDARD_VAULT', 'The vault is not available.');
  }
  const dir = join(base, '.brainatlas');
  let info = null;
  try {
    info = await lstat(dir);
  } catch (cause) {
    if (cause?.code !== 'ENOENT') throw new BrainAtlasError('E_STANDARD_READ', 'The standard directory is unreadable.');
  }
  if (info) {
    if (info.isSymbolicLink()) throw new BrainAtlasError('E_STANDARD_SYMLINK', 'Symbolic links are refused.');
    if (!info.isDirectory()) throw new BrainAtlasError('E_STANDARD_PATH', 'The standard directory is invalid.');
  } else await mkdir(dir, { recursive: true });
  const actual = await realpath(dir);
  if (!inside(base, actual))
    throw new BrainAtlasError('E_STANDARD_PATH', 'The standard directory must remain in the vault.');
  const file = join(actual, 'standard.json');
  try {
    const current = await lstat(file);
    if (current.isSymbolicLink()) throw new BrainAtlasError('E_STANDARD_SYMLINK', 'Symbolic links are refused.');
    if (!current.isFile()) throw new BrainAtlasError('E_STANDARD_PATH', 'The standard file is invalid.');
  } catch (cause) {
    if (cause instanceof BrainAtlasError) throw cause;
    if (cause?.code !== 'ENOENT') throw new BrainAtlasError('E_STANDARD_READ', 'The standard file is unreadable.');
  }
  await atomicWriteFile(file, `${JSON.stringify(standard, null, 2)}\n`, { mode: 0o644 });
  return file;
}
