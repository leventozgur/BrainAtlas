---
contract-version: 1
---
# MCP tools contract

## Purpose

Expose read, retrieval, status, lint, and controlled write operations to coding agents over MCP stdio.

## Function signatures

```js
/** @param {{config:Config,paths:ResolvedPaths,env:object}} options @returns {McpServer} */
export function createServer(options);
/** @returns {Promise<void>} */
export function main();
```

## Input

Tool schemas are: `wiki_query{query:string,limit?:number}`, `wiki_read_page{path:string}`, `wiki_read_index{}`, `wiki_list_pages{type?:string}`, `wiki_status{}`, `wiki_lint{}`, `wiki_write_page{path:string,content:string}`, `wiki_update_page{path:string,content?:string,patch?:object}`, `wiki_create_entity{name:string,content:string}`, `wiki_create_concept{name:string,content:string}`, `wiki_add_crosslinks{path:string}`, and `wiki_update_index{}`.

## Output and errors

Read tools return bounded page/index/status/lint data. `wiki_query` first calls the searcher's `refreshIfChanged()`, so pages added, edited, deleted or renamed outside this server process (Obsidian, sync, another agent's MCP server) are returned by the next call; when semantic retrieval is enabled, such a change also schedules a background semantic index update. Write tools are omitted from the advertised tool list when `config.readOnly` is true. Before every write, content is passed to `scanText`; findings fail with `E_SECRET_DETECTED` and matched secret values are never returned. Invalid paths return `E_PATH_ESCAPE`.

## Example

```js
await client.callTool({name:'wiki_query',arguments:{query:'decision log',limit:3}});
```

## Security

Validate relative paths, scan all proposed write content, and avoid returning full content in diagnostics. Read-only mode must not advertise write tools.

## Version

Tool names and schemas above are version 1. Server and stdio signatures are fixed in `packages/mcp/src/index.mjs`.

When semantic retrieval is enabled for the configured module, `wiki_query` adds `semantic:{used:boolean,fallbackReason?:string}` and `mode:lexical|semantic-primary|rrf`. Missing modules or manifests report `module-missing`; module loading failures report `module-load-error`. Provider errors, absent indexes and fingerprint mismatches also fall back to lexical results. An empty index is missing when the vault contains pages. With semantic disabled or excluded from the configured modules the original response shape is preserved. Semantic index updates run in the background after writes or an index miss.
