---
title: ADR-002 cache invalidation
status: superseded
superseded_by: decisions/adr-005-cache-invalidation.md
generated: "2025-02-10"
---
# ADR-002 cache invalidation

## Decision
Cache entries are invalidated by time only. Writes do not clear cached entries; readers accept data that is at most one TTL old.

## Context
Write volume was low when this decision was made, so the simplicity of time-based expiry outweighed the staleness risk. The TTL at that time was 300 seconds.

## Status
This decision was superseded on 2025-09-01 by [[decisions/adr-005-cache-invalidation]]. It is kept here for history, and the rationale above remains the record of why time-based expiry was chosen first.

## Consequences
Teams that depended on fresh reads after writes added workarounds, which are documented in the team notes. The workarounds were removed when the replacement decision landed.

## Alternatives considered
Event-based invalidation was discussed but rejected at the time because it needed a reliable delivery channel that did not yet exist. Versioned keys were also discussed and set aside, since they multiplied the number of entries that each node had to hold in memory.
