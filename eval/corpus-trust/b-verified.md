---
title: "Index cache invalidation"
type: concept
status: confirmed
generated: "2026-01-10"
sources:
  - "wiki/sources/trust-dev.md"
verified:
  - date: "2026-01-12"
    evidence: "dev fixture review"
    scope: "Index cache invalidation"
    source: "wiki/sources/trust-dev.md"
aliases: []
keywords: []
---
# Index cache invalidation

Cached indexes are invalidated when the stat fingerprint of a page changes, so a rewrite of the same size is caught by the ctime.
