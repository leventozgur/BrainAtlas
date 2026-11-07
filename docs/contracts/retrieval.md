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
/** @param {{vaultDir:string,stateDir:string,now?:Date}} options @returns {{search:(q:string,opts?:object)=>SearchResult,refresh:()=>Promise<void>}} */
export function createSearcher(options);
/** @param {string} s @returns {string} */
export function normalizeText(s);
/** @param {string} token @returns {string} */
export function stem(token);
```

`Page` is `{path:string,title:string,aliases:string[],keywords:string[],headings:string[],body:string,frontmatter:object}`. `SearchResult` is `{results:Array<{path:string,title:string,score:number,snippet:string,stale:boolean,status:string|null}>,abstained:boolean,reason:string|null,truncated:boolean}`.

## Input

Search options default to `limit=5` and support character budget, as-of date, and abstention threshold. `normalizeText` folds Turkish and English case/diacritics; `stem` normalizes an individual token.

## Output and errors

Results contain evidence paths, bounded snippets, scores, freshness, and status. If the score/evidence does not meet threshold, `abstained` is true with a reason. Truncation is explicit. Invalid inputs produce typed errors without echoing sensitive content.

## Example

```js
const answer = search(index, 'vault backup', {limit:3,budgetChars:1200});
```

## Security

Keep all paths inside the vault, respect frontmatter freshness, and never log queries or snippets. Abstain when evidence is weak.

## Version

Public signatures are fixed in `packages/core/src/retrieval/index.mjs`. Contract version 1.
