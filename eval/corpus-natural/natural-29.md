---
title: "Swift concurrency cancellation"
status: "confirmed"
generated: "2026-10-01"
stale_after: "2031-12-31"
---

# Swift concurrency cancellation

## Context

Cancellation in structured concurrency is a signal that work is no longer needed, not a magical interruption of every function. Long loops and adapters must check the task state and pass cancellation to underlying operations where possible. Cleanup still belongs in a well-defined defer path.

## Design considerations

A cancelled search should not publish partial results as if they were complete. Tests can suspend a fake service, cancel its parent task, and assert that no later UI update occurs.

## Example

```text
try Task.checkCancellation()
```


## Practical details

A view can tie its load task to its lifecycle, causing disappearance to request cancellation. In a long loop, `Task.checkCancellation()` throws when cancellation has been requested, so later iterations and publication are skipped. Wrap cleanup in `defer` and distinguish cancellation from an unexpected failure. A fake service that suspends until released can demonstrate that a cancelled task does not update the view after the screen closes.
