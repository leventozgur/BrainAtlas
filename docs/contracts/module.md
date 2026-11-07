---
contract-version: 1
---
# Module contract

## Purpose

Describe, discover, order, and activate optional BrainAtlas modules.

## Function signatures

```js
/** @param {string} dir @returns {ModuleManifest} */
export function readModuleManifest(dir);
/** @param {string} releaseDir @returns {Promise<ModuleManifest[]>} */
export function discoverModules(releaseDir);
/** @param {ModuleManifest[]} manifests @returns {ModuleManifest[]} */
export function resolveModuleOrder(manifests);
/** @param {ModuleContext} ctx @returns {Promise<void>} */
export async function activate(ctx);
/** @type {Record<string, Function>} */
export const commands;
```

`ModuleManifest` is `{name:string,version:string,description:string,requires:string[],provides:string[],profiles:Array<'lite'|'full'|'custom'>,entry:string,experimental?:boolean}`. `ModuleContext` is `{config:Config,paths:ResolvedPaths,env:object,core:object,logger:object}`.

## Input

Manifests live in a module directory as `module.json`; `requires` names modules whose activation must precede this module. Module entry exports async `activate(ctx)` and `commands` for CLI subcommands.

## Output and errors

Discovery returns validated manifests. Ordering returns dependency-first order; missing dependencies and malformed manifests are errors. A dependency cycle raises `E_MODULE_CYCLE`.

## Example

```js
const ordered = resolveModuleOrder([manifestRequiringReceipts, receiptsManifest]);
// receiptsManifest appears before manifestRequiringReceipts.
```

## Security

Treat manifests and module entry paths as untrusted. Validate entry paths remain within the release and avoid putting secrets in logger calls.

## Version

Core signatures are in `packages/core/src/modules/index.mjs`; entry exports are implemented by each module. Contract version 1.
