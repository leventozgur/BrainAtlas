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

### Abstain reasons

`reason` is `empty-query`, `no_match`, `below_threshold`, or `identifier-not-found` (BA-03 addition; the other values are unchanged).

## Identifiers (BA-03 additions, contract version 1)

An identifier is a token such as `E_WIDGET_TIMEOUT`, `a1b2c3d`, `rc.12`, `2.4.0-rc.12`, `src/lib/retry.mjs`, `--drain-timeout`, `RouteSnapshotCache`, `idempotency_key`, `ADR-009`, or `URLSessionConfiguration.timeoutIntervalForRequest`. Its candidate is a run of letters, digits and `_ . / -`, with leading and trailing `_ . / -` removed. A candidate is an identifier when it:

- contains `_`, or is a dotted version with at least two dots (`1.2.3`);
- mixes letters and digits and is at least four characters long (`v2` and `mp3` are not identifiers);
- has a `.` between two alphanumerics that are not all single letters (`rc.12`, `settings.json`; `i.e`, `e.g`, `a.k.a` are not);
- has at least two case humps (`RouteSnapshotCache`, `URLSessionConfiguration`; `SwiftUI` and `iOS` are not);
- is a `/` path that contains a dot or at least two `/` separators (`src/lib/retry.mjs`; `and/or` is not);
- starts with `--` (a flag), or is an upper-case hyphenated code (`ERR-BASIL`).

Dates are never identifiers: a purely numeric three-part token with one 4-digit year at either end, whose other two parts are a day (1-31) and a month (1-12) in either order (`11.11.2025`, `2026.11.11`, `11/11/2025`, `2025-11-11`). Version strings are unaffected (`1.2.3`, `2.4.0-rc.12`). Plain numbers and ordinary hyphenated words (`follow-up`) are not identifiers either.

Identifiers are normalized with `normalizeText` (case and diacritics folded) but not stemmed or split. Each document gets an exact index `exact` (term to strictly increasing document ids) built from its title, aliases, keywords, headings and body; superseded pages are not indexed. A document identifier also indexes its contiguous sub-chains of segments, so `URLSessionConfiguration` finds `URLSessionConfiguration.timeoutIntervalForRequest` and `retry.mjs` finds `src/lib/retry.mjs`. For paths with more than twelve segments, chains start only in the last four segments, so the basename and its suffixes are always indexed. A query uses only whole identifiers, so a non-consecutive path such as `d3/d5/x.mjs` for `d3/d4/d5/x.mjs` does not match, and a Turkish suffix attached without an apostrophe is not split off.

Ranking: each query identifier is one more BM25F-normalized term. A document that contains it exactly receives its full weight (`idf * 2.5`); a missing identifier lowers the score through the same maximum-score normalization as any unmatched term. The ordinary BM25F terms still come from the identifier's words (`e`, `widget`, `timeout`). A query with no identifier takes exactly the previous path and returns identical results and scores.

Abstention: when no query identifier occurs in any indexed document, and identifiers make up at least 0.2 of the query's units (identifiers plus the remaining content words), `search` returns `{results: [], abstained: true, reason: 'identifier-not-found'}`. The share is `identifiers / (identifiers + distinct remaining content stems)`. Long natural-language questions that mention one unknown identifier are therefore still ranked normally.

The cache schema tag is `retrieval-stat-v5` (it was `v4`), so an existing cache is rebuilt once. `decodeCachedIndex` validates `exact` (plain object of non-empty arrays of strictly increasing, in-range document ids); any violation rebuilds the index. An index without `exact` is rejected by `search` as `E_INDEX_CORRUPT`.

## Example

```js
const answer = search(index, 'vault backup', {limit:3,budgetChars:1200});
```

## Freshness (searcher, contract version 1 additions)

`createSearcher` additionally returns `refreshIfChanged()` and `snapshot()`; `search` and `refresh` keep their signatures. The change check computes a fingerprint from `lstat` values (`size`, `mtimeMs`, `ctimeMs`, `ino`) of the same regular Markdown files `loadPages` reads, plus their vault-relative paths and the schema tag `retrieval-stat-v5`. It reads no page contents. `refreshIfChanged()` returns `false` without any file read when the fingerprint is unchanged, and otherwise rebuilds (reusing the persisted cache only when its key matches) and returns `true`. `snapshot()` returns `{pages, index}` that describe the same vault state: `pages` are every walked page (including superseded ones), and `index` is `buildIndex` over them. When the index came from the cache, the pages are loaded on demand; if the vault changes while they are read, both are rebuilt from that single read. The cache also records the walked pages that were not indexed (superseded or otherwise skipped) so that a cache hit can verify that indexed and skipped pages together equal the walked file set. Limitation: a rewrite that leaves size, mtime, ctime and inode unchanged is not detected, which is accepted because ctime changes on each write on supported filesystems. Symbolic links are not followed or tracked, and the cache stays under `stateDir`. `searchHybrid` in `modules/semantic` accepts an optional `lexicalIndex`, which must be `buildIndex(pages)` for the same pages; without it the index is built from `pages` as before.

## Threat model / cache trust

The persisted cache lives under `stateDir`, which is user-owned and trusted. A cache is accepted only when its key matches the current stat fingerprint and its structure passes validation: plain-object roots and fields, page paths present on disk and unique, page field types, posting ids strictly increasing and in range, counts within their field lengths, and averages equal to the values `buildIndex` computes, and exact identifier postings are non-empty lists of strictly increasing in-range ids. Content is not validated: a cache whose key matches but whose content was made up (for example an emptied title, inflated lengths or a swapped path) is accepted as the index for that vault state. Detecting that would require re-reading page contents, which the cheap freshness check exists to avoid. Anyone able to write to `stateDir` can therefore change search results for the unchanged vault; this is an accepted risk, not a defect of the cache format.

## Security

Keep all paths inside the vault, respect frontmatter freshness, and never log queries or snippets. Abstain when evidence is weak.

## Version

Public signatures are fixed in `packages/core/src/retrieval/index.mjs`. Contract version 1.
