---
title: "HTTP retry policy for safe operations"
status: "active"
generated: "2026-10-01"
stale_after: "2025-01-01"
aliases: ["HTTP reference"]
---

# HTTP retry policy for safe operations

## Context

A retry policy should consider both the operation and the response class. Repeating an idempotent read after a transient connection reset is usually reasonable; repeating a non-idempotent write may duplicate an effect.

## Design considerations

Use bounded attempts, jitter, and a total time budget. Honor a valid server retry hint within local limits, and expose the final classification without logging headers or bodies.

## Example

```text
delay = random(0, min(cap, base * 2 ** attempt))
```


## Practical details

A connection reset can happen after the server applied a write, so the absence of a response is not proof of nonexecution. Retry a read within a bounded budget; retry a write only when its contract makes repetition safe, such as a supported idempotency key reused for the same operation. Apply jitter between attempts and stop on a permanent validation error. Record the final error class without the request payload.
