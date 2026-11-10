---
title: Performance experiments
status: active
generated: "2026-10-01"
---
# Performance experiments

These notes summarise latency experiments on the in-process search index. The experiments used synthetic vaults of several sizes and measured index build time, cold and warm setup time, and per-query latency at the median and the 95th percentile.

## Results
Warm setup is much faster than cold setup because the on-disk cache avoids a full rebuild. Per-query latency stays well below the interactive budget for vaults up to a few thousand pages. The largest cost in a cold start is reading and hashing the files.

## Method
Each measurement was repeated and the median was kept. The synthetic data contains no real content, and the query set was generated from the vocabulary of the vault.

## Decision link
The results support the in-process approach in [[decisions/adr-011-search-backend]]. Ranking behaviour that affects these numbers is described in [[architecture/search-ranking]].

## Limitations
The synthetic vaults do not reproduce every feature of real content, such as very long tables or heavy code blocks. Results should be read as trends, not as guarantees for a specific vault.
