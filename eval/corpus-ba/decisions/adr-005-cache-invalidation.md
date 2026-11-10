---
title: ADR-005 cache invalidation
status: active
generated: "2025-09-01"
---
# ADR-005 cache invalidation

## Decision (2025-09)
Writes publish an invalidation event through the queue. Each node drops the matching cache entries when it receives the event. Entries that are not invalidated still expire by time, as a safety net.

## Context
The earlier time-only rule served stale data after writes. Readers needed fresh values for pricing pages, so the event-based rule replaced it. The change is recorded as the replacement of [[decisions/adr-002-cache-invalidation]].

## Consequences
Invalidation events add a small amount of queue traffic. The event consumer runs on every node and is covered by the queue lock behaviour in [[errors/queue-locked]]. The cache design built on this rule is described in [[architecture/tidewater-cache]].

## Rollout
The event consumer was enabled on one node class first. Stale-read reports fell sharply within a week, and the change was then applied to the remaining node classes. The TTL stayed in place as a safety net throughout the rollout.
