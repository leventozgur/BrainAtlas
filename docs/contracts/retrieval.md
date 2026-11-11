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

Each result may additionally contain `heading`, `anchor`, and `headingPath`, each a string or null. These optional fields are backwards-compatible additions to version 1. When a section matches, `snippet` starts with its original Markdown heading line followed by its text; `heading` is its title, `headingPath` joins its ancestor headings and title with ` > `, and `anchor` is a GitHub-style kebab-case identifier. Anchors fold case and diacritics (including Turkish dotted and dotless I), retain letters, digits, underscores and hyphens, and use `-1`, `-2`, etc. to resolve collisions within the page. Headings at levels 1–3 delimit sections; headings inside backtick code fences are ignored. The section with the largest sum of IDF weights for distinct matching query stems wins, with the first section breaking ties, unless dated or current sections take part (see Date-aware section choice below). If no section matches, the snippet is the trimmed start of the body and the three fields are null; a headingless body therefore contains only its text. The existing character budget and truncation rules apply to the whole selected snippet, including its heading line.

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

## Date-aware section choice and superseded routing (BA-04 additions, contract version 1)

**Section choice.** Ranking is unchanged; only the snippet's section is chosen differently, and only when the page has dated or current headings. A heading is dated when its title contains an ISO date `YYYY-MM-DD` (optionally followed by `THH:MMZ`) or `DD.MM.YYYY`; an invalid calendar date counts as no date. A heading is current when it contains `Current` or `Güncel durum` as a marker (case and diacritics folded). Among the sections whose term score is at least 0.6 of the best section's score, the section is chosen in this order: a current-marked section first, then the newest dated section not after the search's `asOf`, then the higher score, then the earlier section. A dated section after `asOf` is not yet in force and is not preferred. If no section is dated or current among those candidates, the best-scoring section is chosen as before, so a page without such headings gets exactly the previous snippet. The share 0.6 was tuned on the development current-state set (where 0.5 to 0.75 gave the same result); it is not a holdout-tuned value.

**Superseded routing.** A superseded page (`status: superseded` or a `superseded_by` key) stays out of the index. At index time its `superseded_by` chain is followed to the first indexed page. A chain A -> B -> C routes both A and B to C. A chain that loops, names a page that is not walked or not indexed, or has no target routes nothing. When the replacement page appears in a result, that result carries `supersedes`: the sorted vault-relative paths of every superseded page routed to it. The field is present only when there is at least one such page. Ranking, score and abstention are not affected: the superseded page's title and aliases are not added to the replacement's text. The index stores the routing as `index.supersedes` (replacement path to the sorted list of superseded paths), and the cache stores it beside `skipped`. Cache validation requires every target to be an indexed page, and every listed source to be a skipped page in a non-empty, strictly increasing list. A cache without `supersedes` (written before BA-04) is rejected and rebuilt once. The schema tag stays `retrieval-stat-v6`, because the BA-17 acceptance tests pin it. Cache content is still not re-read, as described under the threat model.

## Identifiers (BA-03 additions, contract version 1)

An identifier is a token such as `E_WIDGET_TIMEOUT`, `a1b2c3d`, `rc.12`, `2.4.0-rc.12`, `src/lib/retry.mjs`, `--drain-timeout`, `RouteSnapshotCache`, `idempotency_key`, `ADR-009`, or `URLSessionConfiguration.timeoutIntervalForRequest`. Its candidate is a run of letters, digits and `_ . / -`, with leading and trailing `_ . / -` removed. A candidate is an identifier when it:

- contains `_`, or is a dotted version with at least two dots (`1.2.3`);
- mixes letters and digits and is at least four characters long (`v2` and `mp3` are not identifiers);
- has a `.` between two alphanumerics that are not all single letters (`rc.12`, `settings.json`; `i.e`, `e.g`, `a.k.a` are not);
- has at least two case humps (`RouteSnapshotCache`, `URLSessionConfiguration`; `SwiftUI` and `iOS` are not);
- is a `/` path that contains a dot or at least two `/` separators (`src/lib/retry.mjs`; `and/or` is not);
- starts with `--` (a flag), or is an upper-case hyphenated code (`ERR-BASIL`).

Dates are never identifiers: a purely numeric three-part token with one 4-digit year at either end, whose other two parts are a day (1-31) and a month (1-12) in either order (`11.11.2025`, `2026.11.11`, `11/11/2025`, `2025-11-11`). Version strings are unaffected (`1.2.3`, `2.4.0-rc.12`). Plain numbers and ordinary hyphenated words (`follow-up`) are not identifiers either.

Identifiers are normalized with `normalizeText` (case and diacritics folded) but not stemmed or split. Each document gets an exact index `exact` (term to strictly increasing document ids) built from its title, aliases, keywords, headings and body; superseded pages are not indexed. A document identifier also indexes its contiguous sub-chains of segments, so `URLSessionConfiguration` finds `URLSessionConfiguration.timeoutIntervalForRequest` and `retry.mjs` finds `src/lib/retry.mjs`. For keys with more than twelve segments, chains start only in the last four `/` path components (BA-17), each taken whole even when it contains `.` or `-`, so the basename and its 2- to 4-component suffixes are always indexed whatever the depth; a key without `/` keeps the last four segments. A query uses only whole identifiers, so a non-consecutive path such as `d3/d5/x.mjs` for `d3/d4/d5/x.mjs` does not match, and a Turkish suffix attached without an apostrophe is not split off.

Ranking: each query identifier is one more BM25F-normalized term. A document that contains it exactly receives its full weight (`idf * 2.5`); a missing identifier lowers the score through the same maximum-score normalization as any unmatched term. The ordinary BM25F terms still come from the identifier's words (`e`, `widget`, `timeout`). A query with no identifier takes exactly the previous path and returns identical results and scores.

Abstention: when no query identifier occurs in any indexed document, and identifiers make up at least 0.2 of the query's units (identifiers plus the remaining content words), `search` returns `{results: [], abstained: true, reason: 'identifier-not-found'}`. The share is `identifiers / (identifiers + distinct remaining content stems)`. Long natural-language questions that mention one unknown identifier are therefore still ranked normally.

The cache schema tag is `retrieval-stat-v6` (it was `v5` before BA-17, and `v4` before that), so an existing cache is rebuilt once. `decodeCachedIndex` validates `exact` (plain object of non-empty arrays of strictly increasing, in-range document ids); any violation rebuilds the index. An index without `exact` is rejected by `search` as `E_INDEX_CORRUPT`.

## Example

```js
const answer = search(index, 'vault backup', {limit:3,budgetChars:1200});
```

## Freshness (searcher, contract version 1 additions)

`createSearcher` additionally returns `refreshIfChanged()` and `snapshot()`; `search` and `refresh` keep their signatures. The change check computes a fingerprint from `lstat` values (`size`, `mtimeMs`, `ctimeMs`, `ino`) of the same regular Markdown files `loadPages` reads, plus their vault-relative paths and the schema tag `retrieval-stat-v6`. It reads no page contents. `refreshIfChanged()` returns `false` without any file read when the fingerprint is unchanged, and otherwise rebuilds (reusing the persisted cache only when its key matches) and returns `true`. `snapshot()` returns `{pages, index}` that describe the same vault state: `pages` are every walked page (including superseded ones), and `index` is `buildIndex` over them. When the index came from the cache, the pages are loaded on demand; if the vault changes while they are read, both are rebuilt from that single read. The cache also records the walked pages that were not indexed (superseded or otherwise skipped) so that a cache hit can verify that indexed and skipped pages together equal the walked file set. Limitation: a rewrite that leaves size, mtime, ctime and inode unchanged is not detected, which is accepted because ctime changes on each write on supported filesystems. Symbolic links are not followed or tracked, and the cache stays under `stateDir`. `searchHybrid` in `modules/semantic` accepts an optional `lexicalIndex`, which must be `buildIndex(pages)` for the same pages; without it the index is built from `pages` as before.

## Page links and graph expansion (BA-08 additions, contract version 1)

**Link graph.** `buildIndex` derives an undirected graph over the indexed pages (superseded pages are not indexed and never linked). Edges come from wikilinks `[[name]]`, `[[name|label]]`, `[[name#section]]` and relative Markdown links (bracketed text followed by a parenthesised relative `.md` path, optionally with an `#anchor`). Embeds (`![[...]]`, `![...](...)`), fenced code, inline code, external or scheme URLs, `#` and `/` links, links to non-Markdown files, and paths that leave the vault are ignored. A relative Markdown link resolves against its page's directory and must match an indexed page's exact path (case and diacritics folded). A wikilink name resolves to the one indexed page whose exact path matches it; otherwise to the one page whose path suffix, file name, title or alias matches (case and diacritics folded). An ambiguous or unknown name links nothing. Self-links and duplicates are dropped. The graph is stored as `index.links`: a plain object from document id (as a string) to a sorted list of neighbour ids, symmetric by construction.

**Expansion at query time.** After the lexical ranking and the abstention decision, each direct neighbour of the top `LINK_TOP = 3` results receives `LINK_ALPHA = 0.5` times its source's score, further multiplied by its own trust factor since BA-09 (see "Provenance trust" below). A neighbour already ranked keeps the larger of its own score and that value; a new neighbour is added. Ordering is the same as before (score descending, then path). `via: 'link'` marks a result whose score came from a link value. The first result cannot change, since every link value is below the best lexical score. Abstention (`below_threshold`, `no_match`, `identifier-not-found`) is decided on the lexical ranking only, so link expansion never answers an unanswered query. A corpus without links produces exactly the previous results and scores.

**Result fields.** A result may carry `related` (sorted paths of its direct neighbours in either direction, at most five) when its page has at least one neighbour, and `via: 'link'` when it was placed or scored by a link. Both are absent otherwise. The optional keys of contract version 1 are extended by these two; the required keys are unchanged.

**Cache.** `links` is part of the persisted index. `decodeCachedIndex` requires it: keys are in-range document ids, neighbour lists are non-empty, strictly increasing, in range, never self-referential, and symmetric. A cache without `links` (written before BA-08) or with an invalid graph is rejected and rebuilt once. The schema tag stays `retrieval-stat-v6` because the BA-17 acceptance tests pin it; the structural check handles the migration. Graph content is not re-read, as described under the threat model.

**Tuning.** `LINK_TOP` and `LINK_ALPHA` were checked on the development sets (K in {1, 2, 3, 5}, alpha in {0.25, 0.5, 0.75}). On those sets every combination gave the same metrics, so the defaults 3 and 0.5 from the BA-08 brief were kept. The graph development set is `eval/dev/multihop-hard-cases.json` over `eval/corpus-graph/`.

## Provenance trust (BA-09 additions, contract version 1)

**Classes.** Every indexed page has one trust class, computed at index time from its frontmatter. `verified`: `status: confirmed` and at least one `verified` record whose `date` is a valid calendar date (quoted or unquoted, `YYYY-MM-DD` or a UTC timestamp with `Z`; the author's text is checked, so `2026-02-30`, `2026-02-29`, `2026-11-31` and `2026-11-01T25:00:00Z` are invalid whether quoted or not, and an offset such as `+03:00` is not UTC) and whose `evidence`, `scope` and `source` are non-empty strings. `weak`: `status: proposed` or `disputed`, with or without records. `neutral`: every other page, including `confirmed` without a valid record, a status outside these three, and pages with no provenance. Status values are matched exactly. Superseded pages are not indexed and have no class.

**Scoring.** After the lexical BM25F score is computed and compressed as described above, it is multiplied by `1 + TRUST_BOOST` (1.5) for `verified` pages, by `1 - TRUST_PENALTY` (0.9) for `weak` pages and by 1 for `neutral` pages. The two constants are internal, not configuration keys. They were chosen on the BA-09 development set (`eval/dev/trust-cases.json` over `eval/corpus-trust/`) and checked against the other development sets; the holdout was not used for tuning. A `verified` score can therefore exceed 1 (at most 1.5); other scores keep their range.

**Abstention.** The abstention decision uses the best lexical score before the trust factor and before link expansion. A weak page cannot turn an answered question into an abstention, and a verified page cannot turn an unanswered question into an answer. The abstain reasons are unchanged.

**Order.** Results are ordered by the trust-adjusted score, then by path. Link expansion (BA-08) runs on the adjusted scores. A neighbour's link value is `LINK_ALPHA x source adjusted score x neighbour trust factor` (0.5 x source x 0.9 for a weak neighbour, 0.5 x source x 1.5 for a verified one, 0.5 x source for a neutral one), so a weak page cannot escape its penalty through a link. The first result still cannot change through links: a link value is at most 0.75 of its source score (0.5 x 1.5) and the source score is at most the best adjusted score.

**Result field.** A result may carry `trust: 'verified' | 'weak'`. The field is absent for neutral pages, so a corpus without provenance returns exactly the previous results and scores. `status` and all other fields are unchanged.

**Cache.** Each indexed document stores its `trust`. `decodeCachedIndex` recomputes the class from the cached frontmatter and rejects a cache whose stored class is missing or different; such a cache is rebuilt once. The schema tag stays `retrieval-stat-v6`. As with the other cache checks, this is structural validation under the threat model below.

## Threat model / cache trust

The persisted cache lives under `stateDir`, which is user-owned and trusted. A cache is accepted only when its key matches the current stat fingerprint and its structure passes validation: plain-object roots and fields, page paths present on disk and unique, page field types, posting ids strictly increasing and in range, counts within their field lengths, and averages equal to the values `buildIndex` computes, and exact identifier postings are non-empty lists of strictly increasing in-range ids. Content is not validated: a cache whose key matches but whose content was made up (for example an emptied title, inflated lengths or a swapped path) is accepted as the index for that vault state. Detecting that would require re-reading page contents, which the cheap freshness check exists to avoid. Anyone able to write to `stateDir` can therefore change search results for the unchanged vault; this is an accepted risk, not a defect of the cache format.

## Security

Keep all paths inside the vault, respect frontmatter freshness, and never log queries or snippets. Abstain when evidence is weak.

## Version

Public signatures are fixed in `packages/core/src/retrieval/index.mjs`. Contract version 1.
