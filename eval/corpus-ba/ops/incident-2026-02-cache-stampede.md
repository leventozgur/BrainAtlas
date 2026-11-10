---
title: February cache stampede incident
status: active
generated: "2026-03-03"
---
# February cache stampede incident

In February, a popular catalog key expired on every node at nearly the same moment. Every node sent a refresh request to the origin database, which saturated its connection pool for about eleven minutes. Requests waited, timed out and were retried, which made the load worse until the retries were throttled.

## Timeline
The first alert fired when origin latency crossed its threshold. The on-call engineer reduced the retry count and enabled request coalescing on the affected node class. Recovery began once the coalescing change reached every node.

## Changes made
The cache now serves stale entries for a short grace period while one request refreshes them. The grace behaviour and its default are described in [[architecture/tidewater-cache]]. Request coalescing is enabled for all catalog reads.

## Follow-up
A review of the alert thresholds found that the origin alert fired too late. The threshold was lowered and the change is noted in [[ops/monitoring]].
