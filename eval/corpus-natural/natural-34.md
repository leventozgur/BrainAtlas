---
title: "Cache invalidation after mutation"
status: "active"
generated: "2026-10-01"
stale_after: "2025-01-01"
aliases: ["Cache reference"]
---

# Cache invalidation after mutation

## Context

A successful write can leave an older cached representation visible unless the affected key is invalidated or refreshed. Mapping mutation inputs to cache keys is a domain responsibility; broad cache clearing may hide a missing dependency while causing avoidable load.

## Design considerations

Test the sequence read, update, read again with a fake store. Include a failed update to prove that a rejected write does not publish data that never committed.

## Example

```text
await cache.delete(`item:${id}`)
```


## Practical details

Suppose item 7 is cached, then its title changes successfully: remove the key for item 7 before the next read, or replace it with the committed representation. A failed transaction must leave the cached committed value intact. Related list entries may need invalidation too, depending on the data model. In a multi-worker deployment, local eviction alone may not reach other processes; use a shared invalidation mechanism where required.
