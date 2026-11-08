---
title: "Preserving causes in Node error chains"
status: "confirmed"
generated: "2026-10-01"
stale_after: "2031-12-31"
---

# Preserving causes in Node error chains

## Context

A wrapper that replaces every thrown error with a generic message makes failures hard to diagnose. Preserve the original cause while adding a stable operation label, and keep rendered messages separate from structured fields. The boundary should decide which details are safe to expose.

## Design considerations

Consumers can branch on a documented code instead of parsing prose. Avoid copying a request body into the error; even a debug trace should carry a short correlation token rather than user content.

## Example

```text
throw new Error("read failed", { cause: error })
```


## Practical details

The wrapper can attach a stable code such as `READ_FAILED` and retain the underlying exception in `cause`. A caller may show a short message while an authorized diagnostic path inspects the chain. Tests should check that the original error object remains reachable, including when the cause is itself wrapped. Never assume the nested message is safe for display: file paths or input fragments can appear there even if the outer label is harmless.

Before wrapping an observed failure, record the smallest reproduction, expected result, actual result, and environment. Preserve those observations alongside the exception chain so later diagnosis can distinguish the symptom from the proposed fix.
