---
title: ADR-009 queue ordering
status: active
generated: "2026-02-20"
---
# ADR-009 queue ordering

## Decision (2026)
Ordering is guaranteed only within a partition key. Messages that share a key are delivered first-in first-out. Messages with different keys may be delivered in any order, and consumers must not assume a global sequence.

## Context
The global order from [[decisions/adr-004-queue-ordering]] limited throughput and made consumer restarts slow. Per-key ordering keeps the guarantee that matters for catalog updates while allowing parallel delivery.

## Consequences
Producers must set the key for every message that has an ordering requirement. Locks are held per partition, so the lock errors described in [[errors/queue-locked]] apply to a single key range. The delivery behaviour is summarised in [[architecture/larkspur-queue]].

## Migration
Existing producers were updated to set partition keys before the change was enabled. Consumers ran in compatibility mode for two releases so that messages produced under the old rule were still processed in order.

## Open points
Cross-key ordering for compensating messages is still undecided. Until a decision is made, producers that need cross-key order must route both messages through a single key, accepting the throughput cost.
