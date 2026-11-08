---
title: "Markdown link validation"
status: "active"
generated: "2026-10-01"
stale_after: "2025-01-01"
---

# Markdown link validation

## Context

A link checker can find broken local references without fetching remote pages. Resolve relative targets against the source document, normalize separators, and confirm that the result remains inside the documentation root. Fragments need separate checks against actual heading anchors.

## Design considerations

Generated files may not exist until a build step, so the checker needs a declared allowlist for those paths. An allowlist entry should explain its origin and should not become a blanket ignore.

## Example

```text
target = resolve(dirname(source), href)
```


## Practical details

For a document in a nested folder, resolve a relative link from that document's directory rather than from the process working directory. Check the file exists inside the allowed root, then validate any fragment against the generated heading anchor. A missing local file should fail the check with its source location. External links can remain untouched, making this check suitable for an offline build.
