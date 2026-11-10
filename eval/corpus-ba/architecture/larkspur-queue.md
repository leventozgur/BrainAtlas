---
title: Larkspur queue
status: active
generated: "2026-09-02"
aliases: [queue, delivery queue]
---
# Larkspur queue

The Larkspur queue delivers messages to consumers in partitions. Ordering inside a partition follows the rules in [[decisions/adr-009-queue-ordering]]. Each consumer holds a lock on the partitions it reads, and the lock behaviour is described in [[errors/queue-locked]].

## Update 2025-11-02 — retry limit set to 3
Consumers retry a failed message up to three times. After the third failure the message is moved to the dead-letter topic for manual review.

## Update 2026-03-04 — retry limit raised
The retry limit was raised from three to six after the March incident. Backoff doubles from two seconds and stops at two minutes. Messages that exceed the new limit still move to the dead-letter topic, and the dead-letter entry records the number of attempts.

## Update 2026-07-19 — dead-letter topic renamed
The dead-letter topic is now called larkspur.dlq.v2. Tooling that reads the older dead-letter name is deprecated and will be removed after the next major release. Replay tools accept both names during the transition.
