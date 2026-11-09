---
title: "State versus status"
status: "active"
generated: "2026-10-01"
stale_after: "2025-01-01"
---

# State versus status

## Context

A component state is the data that determines its current rendering or behavior, often changing after an event. A status field is commonly a compact label such as active, disputed, or complete. The distinction matters when a query asks about a value transition rather than a classification.

## Design considerations

Do not merge the two documents just because both mention a lifecycle. Link them only where a concrete example needs to explain how internal state maps to an external status.

## Example

```text
state.count = state.count + 1
```


## Practical details

A tap can increment an internal counter, causing the view to render the updated value. A record's external status is a separate field: validate an allowed transition, such as `active` to `complete`, then persist the new label. Reject unsupported transitions rather than changing an unrelated view counter. The UI may display that status, but rendering state and the stored classification have different owners and lifetimes.
