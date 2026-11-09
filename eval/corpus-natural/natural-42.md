---
title: "Observability with bounded labels"
status: "active"
generated: "2026-10-01"
stale_after: "2025-01-01"
keywords: ["Observability", "reference"]
---

# Observability with bounded labels

## Context

Metrics labels create a new time series for every distinct value, so identifiers from requests do not belong in label dimensions. Prefer a small vocabulary such as outcome, operation class, and region category.

## Design considerations

Detailed correlation belongs in sampled traces with access controls. A review can estimate cardinality before shipping a new label and set an explicit ceiling for dashboards.

## Example

```text
counter.add(1, { outcome: "timeout", operation: "read" })
```


## Practical details

If a label contains a different request identifier on every call, a thousand requests can create a thousand series for one operation. Group metrics by a bounded outcome such as success or timeout instead. Individual request correlation can live in access-controlled traces with a sampling policy. Before adding a dimension, estimate the product of possible values across all labels and compare it with the monitoring budget.
