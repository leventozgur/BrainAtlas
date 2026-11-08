---
title: "Document freshness review interval"
status: "active"
generated: "2026-10-01"
stale_after: "2025-01-01"
---

# Document freshness review interval

## Context

A note about a changing interface can become misleading even when every sentence was accurate when written. Set `stale_after` according to the pace of change and make review ownership a role, not a personal name. Expiry is a prompt to verify, not proof that the evidence is false.

## Design considerations

A freshness pass checks links, version references, and whether a newer confirmed decision exists. If the original claim still holds, record the review date rather than rewriting its history.

## Example

```text
stale_after: "2031-06-01"
```


## Practical details

An expired review date should lower confidence and prompt a fresh check; it does not by itself establish that the claim is wrong. Inspect the cited interface version and look for a newer decision before relying on the note. If the behavior still holds, record the review and select a new date based on how quickly the interface changes. If it changed, preserve the earlier claim and link the newer evidence.
