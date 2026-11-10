---
title: Larkspur client API
status: active
generated: "2026-06-30"
---
# Larkspur client API

The Larkspur client is the library that producers and consumers use to talk to the queue. It is a thin wrapper over the broker protocol and keeps no hidden state beyond the batch buffer.

## LarkspurClient.flushBatch
flushBatch sends every buffered message in one request and returns the number of messages the broker accepted. Calls are idempotent for a given batch identifier, so retrying a flush after a timeout cannot duplicate messages. A flush with an empty buffer returns zero and sends nothing.

## LarkspurClient.ackMessage
ackMessage confirms the delivery of one message. A message that is not acknowledged before its visibility timeout expires is redelivered to another consumer. Consumers should acknowledge after their side effects are committed, not before.

## Configuration
The client reads its endpoint and batch size from the service configuration. The default batch size is intentionally small. Ordering guarantees depend on the partition key, which is described in [[architecture/larkspur-queue]].

## Contention
Lock contention between consumers produces the error described in [[errors/queue-locked]]. The client does not retry that error on its own, so callers should add the backoff described there.
