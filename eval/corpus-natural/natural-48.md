---
title: "Queue ordering versus priority"
status: "active"
generated: "2026-10-01"
stale_after: "2025-01-01"
keywords: ["Queue", "reference"]
---

# Queue ordering versus priority

## Context

A FIFO queue preserves arrival order, while a priority queue selects work according to a ranking rule. Adding a priority field to an ordinary queue does not change its behavior unless the consumer uses that field when choosing the next item.

## Design considerations

For equal priorities, define a stable tie breaker. Without it, repeated runs can reorder tasks and make a bug appear intermittent.

## Example

```text
next = heap.popMin()
```


## Practical details

A min-heap returns the item with the smallest priority value; after removal it restores heap order before the next selection. With priorities 3, 1, and 2, the first item selected has priority 1. For equal values, append an arrival sequence to the comparison so earlier work wins. If urgent work arrives continuously, consider an aging rule to prevent low-priority items from waiting indefinitely.
