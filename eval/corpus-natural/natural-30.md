---
title: "SwiftUI navigation state restoration"
status: "confirmed"
generated: "2026-10-01"
stale_after: "2031-12-31"
---

# SwiftUI navigation state restoration

## Context

Restoring a navigation path after relaunch can make a deep workflow feel continuous, but the saved representation must survive schema changes. Store stable route values and validate them against currently available content before rebuilding the stack.

## Design considerations

An unavailable destination should fall back to a sensible root rather than leave an empty interface. Restoration tests should cover an older payload and a route removed from the active catalog.

## Example

```text
@SceneStorage("navigationPath") private var encodedPath = "[]"
```


## Practical details

Persist a compact sequence of route identifiers rather than entire view models. On launch, decode the sequence, check each destination against the current catalog, and stop at the first unavailable element. An old payload containing a removed destination should land on a valid parent or root. Version the representation when route meanings change, and test both an empty stack and a multi-level stack after relaunch.
