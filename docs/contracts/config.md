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
/** @param {Config} cfg @param {string} dottedKey @returns {Config} */
export function unsetConfigValue(cfg, dottedKey);
/** @param {unknown} obj @param {{backupDir:string,now?:Date}} options @returns {Promise<{config:Config,applied:string[],backupPath:string|null}>} */
export function migrateConfig(obj, options);
/** @param {{platform?:string,env:Record<string,string|undefined>}} options @returns {ResolvedPaths} */
export function resolvePaths(options);
/** @param {string} absPath @returns {string} */
export function vaultId(absPath);
```

`CONFIG_SCHEMA` is a JSON Schema draft 2020-12 object. `PROFILES` maps `lite`, `full`, and `custom` to default module lists and locked keys. Lite has no optional modules (`[]`). Full uses the marker `['*']`: every module discovered in the release whose `module.json` `profiles` contains `full` (core never hard-codes optional module names, so the Lite purity guard holds). Custom starts empty. `safety.secretFilter` is locked to `true` in Lite and Full; only the custom profile may set it to `false` (see the safety contract); `telemetry` is locked to `false` in Lite.

## Input

The v1 config shape is `{schemaVersion:1,profile,vault:{path},modules:string[],agents:string[],scope:'global'|'vault',retrieval:{budgetChars,abstainThreshold},hooks:{mode:'normal'|'economic'|'manual',deadlineMs},safety:{secretFilter:boolean,extraDenyGlobs:string[]},okf:{level:'warn'|'strict'},sync:{transport:string|null,options:object},telemetry:false,readOnly:boolean,node:{path:string}}`. Path resolution uses injected `env.HOME` and `env.XDG_*`; it never calls `os.homedir()`.

Path mapping: macOS uses `~/Library/Application Support/BrainAtlas/{releases/<v>/,current,bin/brainatlas,config.json,state/<vault-id>/,install-manifest.json}`. Linux uses `${XDG_DATA_HOME:-~/.local/share}/brainatlas`, `${XDG_CONFIG_HOME:-~/.config}/brainatlas/config.json`, and `${XDG_STATE_HOME:-~/.local/state}/brainatlas/<vault-id>/`. `vault-id` is the first 16 hex characters of SHA-256 over the vault's absolute path.

## Output and errors

Validation returns `{ok,errors}`. Load, save, and migration are asynchronous; save is atomic. `setConfigValue` raises `BrainAtlasError` with `code:'E_LOCKED_KEY'` for a profile-locked key and `code:'E_CONFIG_KEY'` for an unknown or malformed key. Invalid config reports path-specific error codes without echoing values.

## Example

```js
const config = defaultConfig('lite');
const result = validateConfig(config); // { ok: true, errors: [] }
```

## Security

Do not log configuration values. Reject unknown or escaping paths and retain a migration backup before replacing a config file.

## Version

All listed functions are exported by `packages/core/src/config/index.mjs` and `packages/core/src/paths/index.mjs`; this is contract version 1.

## Optional retrieval exclusions (BA-29)

`retrieval.exclude` is an optional array of non-empty glob patterns relative to the search root (`<vault>/wiki` when present, otherwise the vault root). Absolute paths, drive letters, backslashes and `..` segments are refused with `E_PATH_INVALID`. When the key is absent the default list of `searchScope` applies; an array replaces the default and `[]` gives every page. The key is not written by `defaultConfig`, so existing configuration files stay byte-identical. `brainatlas config set retrieval.exclude '["drafts/**"]'` writes it and `brainatlas config unset retrieval.exclude` removes it again.

## Optional pull-side low confidence (BA-53)

`retrieval.pullLowConfidence` is an optional boolean, default `true` (on). It affects pull queries only: `wiki_query` in MCP and `brainatlas wiki query`. When the key is absent or `true` and the lexical search abstains with `reason: "below_threshold"`, the below-threshold results are returned with `lowConfidence: true` on every row and at the top level, while `abstained` stays `true`; a query with no results keeps the unchanged abstained response. Other abstain reasons (`identifier-not-found`, `no_match`, `empty-query`) and non-abstained answers never produce low-confidence rows. The hook (push) path is not affected. An explicit `false` restores the pre-BA-53 behaviour, where a `below_threshold` abstention returns an empty list. The key is not written by `defaultConfig`, so existing configuration files stay byte-identical; disable it with `brainatlas config set retrieval.pullLowConfidence false` and remove the override with `brainatlas config unset retrieval.pullLowConfidence`.

## Optional key writes

`setConfigValue` accepts a dotted key when every segment resolves through `CONFIG_SCHEMA.properties`. A missing parent that the schema defines as an object is created, the value is set, and the whole configuration is validated afterwards. A segment that the schema does not define at that level fails with `E_CONFIG_KEY` without changing anything; `sync.options.*` stays free-form: a key directly below `sync.options` is accepted without a schema lookup, its deeper parents must already exist as before, and such a key can also be removed. `unsetConfigValue` removes only a known key that is not listed in its parent's `required`: required or unknown keys fail with `E_CONFIG_KEY`, an absent optional key is an idempotent no-op, and profile-locked keys (`telemetry`, `safety.secretFilter`) fail with `E_LOCKED_KEY`. A free-form `sync.options.*` key is removed when present and is a no-op when absent. Key segments named `__proto__`, `constructor` or `prototype` are refused with `E_CONFIG_KEY`. Both functions return a new configuration and never write; the CLI saves through the same tracked path as any other configuration change.

## Optional semantic configuration

Version 1 accepts an optional `semantic` object. Defaults are `enabled:false`, `baseUrl:http://127.0.0.1:11434`, `model:embeddinggemma:300m-qat-q4_0`, `dims:768`, `queryPrefix:"task: search result | query: "`, `documentPrefix:"title: none | text: "`, `minScore:0.45`, `mode:semantic-primary`, `timeoutMs:5000`, `indexTimeoutMs:120000`, `indexBatchSize:32`, `keepAlive:"30m"`, and `allowRemote:false`. Mode may also be `rrf`. Dimensions and timeouts are positive integers; `indexBatchSize` is an integer from 1 to 64. `timeoutMs` applies to queries; `indexTimeoutMs` applies to each indexing request; cosine scores are between -1 and 1. The score threshold is model-specific and must be recalibrated for a different model. Non-loopback providers require explicit `allowRemote:true`; invalid endpoints report `E_SEMANTIC_PROVIDER` without disclosing values.

`semantic.keepAlive` is a duration string matching `^(?:0|[1-9][0-9]{0,4}[smh])$`: `"0"` or a positive count followed by `s`, `m` or `h` (for example `"30m"` or `"2h"`). Any other value fails validation with `E_PATTERN`. A non-`"0"` value is sent as `keep_alive` on every embedding request, so Ollama keeps the local model loaded between prompt hooks; `"0"` sends no field and restores Ollama's own default unload behaviour. The value is not part of the provider fingerprint, so changing it never requires re-indexing. Consumers merge the `"30m"` default from `SEMANTIC_DEFAULTS` in memory, while `defaultConfig` and `loadConfig` never write the key, so configuration files stay readable by older releases; `brainatlas config set semantic.keepAlive <value>` writes it only when the user sets it. Session start, and a prompt whose semantic step missed its deadline, may run one in-process `"warm-up"` embedding with the same settings after the hook output is flushed; it is rate-limited to one per state directory per minute and is awaited for at most 2000 ms, never aborting the request before that cap and never changing hook output or metrics.

## Optional maintenance synthesis

Version 1 accepts an optional `maintain.synthesis` object for the current-state proposal step of `brainatlas maintain --weekly`. All keys are optional and have defaults: `mode` is `off` (also `shadow` or `on`), `command` is `[]` (the argv of the external model command, for example `["claude","-p","--model","claude-haiku-5-5"]`), `pagesPerWeek` is 1 (integer 1..3), `maxInputChars` is 60000 (integer 1000..200000), `maxCallsPerWeek` is 3 (integer 1..10), `maxUsdPerWeek` is 0.5 (number 0..20), `usdPer1kTokens` is 0.005 (number 0..1) and `timeoutMs` is 180000 (integer 10000..600000). `maintain` and `maintain.synthesis` reject unknown keys. An existing configuration without `maintain` stays valid and behaves as `mode: off`; `defaultConfig` does not write the object, so `brainatlas config set maintain.synthesis.mode shadow` (or `config set maintain.synthesis.command '["opencode","run","-m","opencode-go/deepseek-v4.1-flash"]'`) creates it on demand. Values outside these ranges or of the wrong type fail with `E_CONFIG_INVALID`; an unknown dotted key fails with `E_CONFIG_KEY`. The `command` is executed directly (`shell: false`), receives the prompt on stdin and must not be a background process. See "Data sent to the model" in `docs/user/maintain.md` for the egress protections: restricted pages are never sent, the prompt and the output are secret-scanned, the state files are `0600`, `BRAINATLAS_OFFLINE=1` skips the model and `maintain --proposals accept` only writes the configured vault.
