---
contract-version: 1
---
# Retrieval contract

## Purpose

Index Markdown evidence and return ranked, freshness-aware snippets or abstain when evidence is weak.

## Function signatures

```js
/** @param {Page[]} pages @param {{now?:Date}} options @returns {Index} */
export function buildIndex(pages, options);
/** @param {Index} index @param {string} query @param {{limit?:number,budgetChars?:number,asOf?:Date,abstainThreshold?:number}} options @returns {SearchResult} */
export function search(index, query, options);
/** @param {{vaultDir:string,stateDir:string,now?:Date}} options @returns {{search:(q:string,opts?:object)=>SearchResult,refresh:()=>Promise<void>,refreshIfChanged:()=>boolean,snapshot:()=>{pages:Page[],index:Index}}} */
export function createSearcher(options);
/** @param {string} s @returns {string} */
export function normalizeText(s);
/** @param {string} token @returns {string} */
export function stem(token);
```

`Page` is `{path:string,title:string,aliases:string[],keywords:string[],headings:string[],body:string,frontmatter:object}`. `SearchResult` is `{results:Array<{path:string,title:string,score:number,snippet:string,stale:boolean,status:string|null}>,abstained:boolean,reason:string|null,truncated:boolean}`.

Each result may additionally contain `heading`, `anchor`, and `headingPath`, each a string or null. These optional fields are backwards-compatible additions to version 1. When a section matches, `snippet` starts with its original Markdown heading line followed by its text; `heading` is its title, `headingPath` joins its ancestor headings and title with ` > `, and `anchor` is a GitHub-style kebab-case identifier. Anchors fold case and diacritics (including Turkish dotted and dotless I), retain letters, digits, underscores and hyphens, and use `-1`, `-2`, etc. to resolve collisions within the page. Headings at levels 1–3 delimit sections; headings inside backtick code fences are ignored. The section with the largest sum of IDF weights for distinct matching query stems wins, with the first section breaking ties. If no section matches, the snippet is the trimmed start of the body and the three fields are null; a headingless body therefore contains only its text. The existing character budget and truncation rules apply to the whole selected snippet, including its heading line.

## Input

Search options default to `limit=5` and support character budget, as-of date, and abstention threshold. `normalizeText` folds Turkish and English case/diacritics; `stem` normalizes an individual token.

## Output and errors

Results contain evidence paths, bounded snippets, scores, freshness, and status. If the score/evidence does not meet threshold, `abstained` is true with a reason. Truncation is explicit. Invalid inputs produce typed errors without echoing sensitive content.

### Errors

- `E_INDEX_CORRUPT`: persisted index is malformed or unreadable; discard and rebuild it from the vault.
- `E_QUERY_INVALID`: query is not a string. Empty, whitespace-only or stopword-only queries do not throw; they return `{results: [], abstained: true, reason: "empty-query"}`.
- `E_VAULT_MISSING`: configured vault directory is unavailable.

## Example

```js
const answer = search(index, 'vault backup', {limit:3,budgetChars:1200});
```

## Freshness (searcher, contract version 1 additions)

`createSearcher` additionally returns `refreshIfChanged()` and `snapshot()`; `search` and `refresh` keep their signatures. The change check computes a fingerprint from `lstat` values (`size`, `mtimeMs`, `ctimeMs`, `ino`) of the same regular Markdown files `loadPages` reads, plus their vault-relative paths and the schema tag `retrieval-stat-v3`. It reads no page contents. `refreshIfChanged()` returns `false` without any file read when the fingerprint is unchanged, and otherwise rebuilds (reusing the persisted cache only when its key matches) and returns `true`. `snapshot()` returns the pages and lexical index of the last refresh; pages are loaded on demand when the index came from the cache. Limitation: a rewrite that leaves size, mtime, ctime and inode unchanged is not detected, which is accepted because ctime changes on each write on supported filesystems. Symbolic links are not followed or tracked, and the cache stays under `stateDir`. `searchHybrid` in `modules/semantic` accepts an optional `lexicalIndex`, which must be `buildIndex(pages)` for the same pages; without it the index is built from `pages` as before.

## Security

Keep all paths inside the vault, respect frontmatter freshness, and never log queries or snippets. Abstain when evidence is weak.

## Version

Public signatures are fixed in `packages/core/src/retrieval/index.mjs`. Contract version 1.
