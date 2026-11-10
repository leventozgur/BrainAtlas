---
title: Search ranking
status: active
generated: "2026-10-05"
aliases: [ranking, retrieval scoring]
---
# Search ranking

Search ranks pages with a BM25-style score that is weighted per field. Titles, aliases, headings and the body are scored separately, and a title match counts more than a body match. Superseded pages are removed from the index before scoring, so they never appear in results.

## Abstention
Results whose normalised top score is below the abstain threshold are not returned. The threshold is a configuration value and defaults to zero, which means every query with at least one matching term returns results. Callers that need precision should raise the threshold and measure the effect with the evaluation tools.

## Sections
After ranking, the engine selects the section of each page that best matches the query and returns its heading. This is why heading text is part of the evaluation.

## Decisions
The choice of an in-process index over an external engine is recorded in [[decisions/adr-011-search-backend]]. Latency numbers from the experiments are in [[notes/perf-experiments]].
