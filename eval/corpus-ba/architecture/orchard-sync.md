---
title: Orchard sync
status: active
generated: "2026-08-03"
---
# Orchard sync

Orchard sync pulls catalog changes from the upstream service every five minutes by default. Each run stores a checkpoint after every page so that an interrupted run can continue from the last saved cursor. Cursor behaviour is described in [[api/orchard-api]].

## Pausing during shutdown
When a Basil shutdown starts during a sync run, the run is paused at the next checkpoint and resumed by the next process that starts. Drain behaviour and the timeout that bounds the pause are set by the flags in [[cli/basil-flags]]. A paused run keeps its lock, so no second sync can start on the same catalog.

## Pending messages
Pausing does not drop pending messages. Messages that were produced before the pause stay in the Larkspur queue ([[architecture/larkspur-queue]]) and are delivered by the consumers as usual. Operators should check the backlog panel in [[ops/monitoring]] after any long pause.

## Metrics
Each run reports the number of pages read, the number of changes applied and the lag between the newest change and the local checkpoint. The lag is the value most often compared against the alert threshold.
