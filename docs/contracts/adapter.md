---
contract-version: 1
---
# Agent adapter contract

## Purpose

Detect an agent installation, preview integration edits, apply/remove owned changes, and report health and trust requirements.

## Function signatures

```js
/** @param {Record<string,unknown>} env @returns {boolean} */
export function detect(env);
/** @param {AdapterContext} ctx @returns {PlanResult} */
export function plan(ctx);
/** @param {PlanResult} planResult @param {AdapterContext} ctx @returns {Promise<void>} */
export function apply(planResult, ctx);
/** @param {AdapterContext} ctx @returns {Promise<void>} */
export function remove(ctx);
/** @param {AdapterContext} ctx @returns {Promise<object>} */
export function doctor(ctx);
/** @param {AdapterContext} ctx @returns {Promise<object>} */
export function trustReview(ctx);
```

`AdapterContext` is `{env,config,paths,scope,nodePath,shimPath,now}`. `PlanResult` is `{changes:Array<{file:string,kind:'create'|'modify'|'delete',before:string|null,after:string|null,ownership:'marked-block'|'json-key'|'toml-table'|'whole-file'}>,warnings:string[],trustReviewRequired:boolean}`.

## Input

Adapters live at `packages/adapters/<adapter>/src/index.mjs`. Markdown ownership uses `<!-- brainatlas:begin -->` and `<!-- brainatlas:end -->`; JSON ownership is `mcpServers.brainatlas`; TOML ownership is `[mcp_servers.brainatlas]`.

## Output and errors

`plan` describes exact before/after bytes. `apply` writes atomically and creates `.bak.<UTC>` backup. Errors include `E_CONFIG_PARSE`, `E_MANAGED_BLOCK_EDITED`, and `E_BOM`.

## Example

```js
const planResult = adapter.plan(ctx);
if (planResult.trustReviewRequired) await adapter.trustReview(ctx);
```

## Security

Do not overwrite user-owned bytes. `apply` followed by `remove` must restore original bytes exactly. If an agent has no hook support, use pull-mode instructions plus MCP.

## Version

`ctx` is `{env,config,paths,scope,nodePath,shimPath,now}`. Contract version 1.
