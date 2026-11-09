---
title: "Process memory versus stored record"
status: "active"
generated: "2026-10-01"
stale_after: "2025-01-01"
---

# Process memory versus stored record

## Context

A running process holds temporary memory that disappears when it exits, while a stored record is intended to survive beyond that lifetime. Confusing the two can lead to an assumption that an in-memory cache is a durable source of truth.

## Design considerations

Recovery design names the authoritative store and treats volatile copies as rebuildable. A restart test is a direct way to find hidden dependence on process-local state.

## Example

```text
const transient = new Map()
```


## Practical details

A process-local map may improve read speed, but restarting the process empties it. Keep the authoritative record in durable storage and rebuild the map from that source on startup. A restart test can write a record, discard the map, and verify that a fresh instance loads the committed value. If a write fails, do not claim the map's temporary value was durably saved; cache lifetime and record lifetime differ.
