---
title: "Cash register versus cache"
status: "disputed"
generated: "2026-10-01"
stale_after: "2025-01-01"
---

# Cash register versus cache

## Context

A cash register records a payment at a point of sale; a software cache keeps a reusable copy of computed or fetched data. Their spellings are close enough to confuse a typo-tolerant search, but their purposes and surrounding vocabulary differ completely.

## Design considerations

Negative examples are useful when tuning fuzzy matching. A query about till reconciliation should not rank cache eviction notes above documents about payment totals and drawer counts.

## Example

```text
register.closeShift({ countedTotal })
```


## Practical details

At shift close, count notes and coins by denomination, add those amounts, and compare the total with the expected cash balance from sales and the opening float. Record any difference for review before closing the shift; card payments are reconciled separately. For example, an expected balance of 120 and a physical count of 118 leaves a difference of minus 2. This procedure concerns a till, not eviction of cached objects.
