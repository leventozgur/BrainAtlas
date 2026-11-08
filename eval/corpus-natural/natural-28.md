---
title: "Search indexing with field weights"
status: "confirmed"
generated: "2026-10-01"
stale_after: "2031-12-31"
keywords: ["Search", "reference"]
---

# Search indexing with field weights

## Context

A title match often carries more intent than a mention buried in a long paragraph. Keeping title, alias, heading, and body counts separate allows a ranker to express that difference without rewriting source pages. Weight changes should be judged against queries that include both useful and distracting matches.

## Design considerations

Very short documents can dominate if term frequency is normalized carelessly. A held-out query set should include rare technical names and everyday phrasing, with expected exclusions recorded beside the positive evidence.

## Example

```text
const fields = [title, aliases, headings, body]
```


## Practical details

For example, a heading hit can receive weight two while a body hit receives weight one; evaluate those values rather than treating them as universal constants. Maintain a versioned synonym map in the index: link “restore” and “recovery” as related terms without editing the original note. Expand only the intended concept and retain a negative example for an unrelated sense. Rebuild or refresh the index when the map changes, then compare ranked results and exclusions.
