---
title: "Search query parser boundaries"
status: "active"
generated: "2026-10-01"
stale_after: "2025-01-01"
---

# Search query parser boundaries

## Context

A query parser should distinguish ordinary punctuation from syntax that changes meaning. Document a small grammar, reject malformed operators predictably, and keep literal text available for a simpler fallback. Silently reinterpreting a broken filter can produce confident but misleading results.

## Design considerations

Parsing errors should report a safe position or category, never echo the full query into routine logs. Fuzz cases can explore nested quotes and repeated separators without any network access.

## Example

```text
filter = parseQuery(input, { mode: "strict" })
```


## Practical details

An unmatched operator should produce a clear parse error with its position, or explicitly fall back to literal search if that behavior is documented. For example, an unfinished quoted filter must not silently become a different field constraint. Test an empty operand, nested quotes, and a trailing separator. The error response can identify the token class without storing the user's entire search string in logs.
