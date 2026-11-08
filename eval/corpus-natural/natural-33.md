---
title: "Database cursor pagination"
status: "active"
generated: "2026-10-01"
stale_after: "2025-01-01"
---

# Database cursor pagination

## Context

Offset pagination becomes expensive when a client walks deep into a changing table. A cursor based on a stable ordering key can continue from the last observed row, but ties need a second deterministic field.

## Design considerations

Cursors should be opaque to clients and validated on receipt. If the underlying sort definition changes, version the cursor format or reject it with a recoverable response.

## Example

```text
ORDER BY created_at, record_id
```


## Practical details

When several records share a creation time, sort by that time and a unique record identifier. The next page starts strictly after the pair from the previous page, not after the timestamp alone. A sample with three equal timestamps across a page boundary should return each row once. Concurrent inserts may still affect what a walk sees, so snapshot isolation or an explicit consistency policy may be needed.
