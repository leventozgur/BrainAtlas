# ADR-0004: MCP tool implementation and core mapping

## Decision

The MCP server owns the tool schemas, bounded response formatting, stdio lifecycle, path scoping, and write safety boundary. `wiki_query` exclusively uses `@brainatlas/core` retrieval through `createSearcher`; it does not call the vendored query/search implementation.

Before any page mutation, the server checks both the vault-relative Wiki path (`scanPath`) and the complete proposed page text (`scanText`), then resolves it with `safeJoin` and `resolveSafePath`. Refusals expose only an error code and generic message. Successful writes append a path/action-only record to `wiki/log.md` and refresh the retrieval searcher.

## Vendored `@llmwiki/core` mapping

| MCP tool | Vendored function(s) |
| --- | --- |
| `wiki_read_page` | `readPage` (bounded output is formatted by MCP) |
| `wiki_read_index` | N/A; bounded file read uses core `resolveSafePath` |
| `wiki_list_pages` | Core `listPages` to include only regular, non-symlink Markdown files |
| `wiki_status` | `getWikiStatus`; OKF counts come from `@brainatlas/core` `checkVault` |
| `wiki_lint` | `lintWiki` |
| `wiki_write_page` | `writePage` after core safety and path checks |
| `wiki_update_page` | `readPage`, then `writePage` after checking the complete replacement |
| `wiki_create_entity` | `createEntityPage` |
| `wiki_create_concept` | `createConceptPage` |
| `wiki_add_crosslinks` | `getPageLinksDetailed`, then `addCrosslinks` |
| `wiki_update_index` | `listPages`, `readPage`, then `writeIndex` |

`wiki_query` is intentionally mapped to core `createSearcher`/`search` rather than the vendored `queryWiki`. Read-only mode registers only the six read/inspection tools.

## Consequences

The vendored operations remain responsible for Wiki markdown/frontmatter formatting, entity/concept index entries, crosslink formatting, and lint rules. MCP performs write validation before invoking operations that can write; generated index/page representations are scanned as well. No public contract signatures were changed.
