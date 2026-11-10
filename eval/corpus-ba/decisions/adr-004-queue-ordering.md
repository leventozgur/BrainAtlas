---
title: ADR-004 queue ordering
status: superseded
superseded_by: decisions/adr-009-queue-ordering.md
generated: "2025-04-18"
---
# ADR-004 queue ordering

## Decision
The queue preserves one global first-in first-out order across all partitions. Consumers process messages in the order they were produced, regardless of the catalog item they concern.

## Context
Early consumers assumed global order, and the simplest correct design followed from that assumption. Throughput was acceptable at the time, so the cost of a single ordering domain was not visible.

## Status
This decision was superseded in 2026 by [[decisions/adr-009-queue-ordering]], which moved ordering to a per-key scope. The global rule is kept here as history. Details of how partitions are locked are in [[errors/queue-locked]].

## Consequences
The global order became a bottleneck when the catalog grew, which motivated the change.

## Alternatives considered
Partition-level ordering with a shared sequence counter was considered and rejected because the counter became a contention point. Ordering by producer was considered but did not match how catalog updates were actually produced across services.
