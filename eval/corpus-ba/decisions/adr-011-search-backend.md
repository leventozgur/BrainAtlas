---
title: ADR-011 search backend
status: active
generated: "2026-03-14"
---
# ADR-011 search backend

## Decision (2026)
Search uses an in-process field-weighted index that is rebuilt when the page fingerprint changes and cached on disk. The external search engine option was rejected for this release.

## Context
The vault is a local directory of markdown files, so an external service would add a network dependency and a second copy of the data. The in-process index keeps startup fast and works offline, which the product requires.

## Consequences
Index builds take longer for very large vaults, and the cache must be invalidated safely when pages change. The ranking rules that the index applies are described in [[architecture/search-ranking]]. The measurements that support this decision are in [[notes/perf-experiments]].

## Review
The decision is reviewed when the vault crosses the size where index builds exceed the cold-start budget. The review uses the measurement method described in the experiments note and must compare warm and cold setup separately.
