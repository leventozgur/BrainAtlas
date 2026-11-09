---
contract-version: 1
---
# Configuration and paths contract

## Purpose

Load, validate, migrate, and persist user configuration, and resolve platform paths from injected environment values.

## Function signatures

```js
/** @param {'lite'|'full'|'custom'} profile @returns {Config} */
export function defaultConfig(profile);
/** @param {unknown} obj @returns {{ok:boolean, errors:Array<{path:string,code:string,message:string}>}} */
export function validateConfig(obj);
/** @param {{paths:ResolvedPaths,env:Record<string,string|undefined>}} options @returns {Promise<Config>} */
export function loadConfig(options);
/** @param {Config} cfg @param {{paths:ResolvedPaths}} options @returns {Promise<void>} */
export function saveConfig(cfg, options);
/** @param {Config} cfg @param {string} dottedKey @param {unknown} value @returns {Config} */
export function setConfigValue(cfg, dottedKey, value);
/** @param {unknown} obj @param {{backupDir:string,now?:Date}} options @returns {Promise<{config:Config,applied:string[],backupPath:string|null}>} */
export function migrateConfig(obj, options);
/** @param {{platform?:string,env:Record<string,string|undefined>}} options @returns {ResolvedPaths} */
export function resolvePaths(options);
/** @param {string} absPath @returns {string} */
export function vaultId(absPath);
```

`CONFIG_SCHEMA` is a JSON Schema draft 2020-12 object. `PROFILES` maps `lite`, `full`, and `custom` to default module lists and locked keys. Lite has no optional modules (`[]`). Full uses the marker `['*']`: every module discovered in the release whose `module.json` `profiles` contains `full` (core never hard-codes optional module names, so the Lite purity guard holds). Custom starts empty. `safety.secretFilter` is locked to `true` in Lite and cannot be disabled in any profile; `telemetry` is locked to `false` in Lite.

## Input

The v1 config shape is `{schemaVersion:1,profile,vault:{path},modules:string[],agents:string[],scope:'global'|'vault',retrieval:{budgetChars,abstainThreshold},hooks:{mode:'normal'|'economic'|'manual',deadlineMs},safety:{secretFilter:true,extraDenyGlobs:string[]},okf:{level:'warn'|'strict'},sync:{transport:string|null,options:object},telemetry:false,readOnly:boolean,node:{path:string}}`. Path resolution uses injected `env.HOME` and `env.XDG_*`; it never calls `os.homedir()`.

Path mapping: macOS uses `~/Library/Application Support/BrainAtlas/{releases/<v>/,current,bin/brainatlas,config.json,state/<vault-id>/,install-manifest.json}`. Linux uses `${XDG_DATA_HOME:-~/.local/share}/brainatlas`, `${XDG_CONFIG_HOME:-~/.config}/brainatlas/config.json`, and `${XDG_STATE_HOME:-~/.local/state}/brainatlas/<vault-id>/`. `vault-id` is the first 16 hex characters of SHA-256 over the vault's absolute path.

## Output and errors

Validation returns `{ok,errors}`. Load, save, and migration are asynchronous; save is atomic. `setConfigValue` raises `BrainAtlasError` with `code:'E_LOCKED_KEY'` for a profile-locked key. Invalid config reports path-specific error codes without echoing values.

## Example

```js
const config = defaultConfig('lite');
const result = validateConfig(config); // { ok: true, errors: [] }
```

## Security

Do not log configuration values. Reject unknown or escaping paths and retain a migration backup before replacing a config file.

## Version

All listed functions are exported by `packages/core/src/config/index.mjs` and `packages/core/src/paths/index.mjs`; this is contract version 1.

## Optional semantic configuration

Version 1 accepts an optional `semantic` object. Defaults are `enabled:false`, `baseUrl:http://127.0.0.1:11434`, `model:embeddinggemma:300m-qat-q4_0`, `dims:768`, `queryPrefix:"task: search result | query: "`, `documentPrefix:"title: none | text: "`, `minScore:0.45`, `mode:semantic-primary`, `timeoutMs:5000`, `indexTimeoutMs:120000`, `indexBatchSize:32`, and `allowRemote:false`. Mode may also be `rrf`. Dimensions and timeouts are positive integers; `indexBatchSize` is an integer from 1 to 64. `timeoutMs` applies to queries; `indexTimeoutMs` applies to each indexing request; cosine scores are between -1 and 1. The score threshold is model-specific and must be recalibrated for a different model. Non-loopback providers require explicit `allowRemote:true`; invalid endpoints report `E_SEMANTIC_PROVIDER` without disclosing values.
