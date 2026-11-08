---
title: "Graceful shutdown in a worker"
status: "active"
generated: "2026-10-01"
stale_after: "2025-01-01"
keywords: ["Graceful", "reference"]
---

# Graceful shutdown in a worker

## Context

A worker should stop accepting new jobs before waiting for active work to finish. A deadline prevents shutdown from hanging forever, while a final signal allows a supervisor to report an incomplete drain. Resource cleanup should be idempotent.

## Design considerations

If the deadline expires, unfinished work needs a visible policy: requeue, abandon safely, or rely on lease expiry. The choice belongs to the queue contract rather than an arbitrary process exit hook.

## Example

```text
await worker.close({ timeoutMs: 8000 })
```


## Practical details

At shutdown, stop polling immediately and give running jobs a bounded interval, such as thirty seconds, to finish. A job that cannot finish before the deadline must follow the queue's lease or requeue policy; acknowledging it early would lose work. Close the connection after the drain attempt and report remaining work. A test with one blocked job and one completed job exercises both paths without waiting indefinitely.
