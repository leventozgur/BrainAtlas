---
title: "Continuous integration matrix sizing"
status: "active"
generated: "2026-10-01"
stale_after: "2025-01-01"
aliases: ["Continuous reference"]
---

# Continuous integration matrix sizing

## Context

A build matrix catches platform-specific issues, yet multiplying every runtime, operating system, and feature flag can turn a quick check into a queue. Start with combinations that represent distinct risk, then add a dimension when evidence shows it changes behavior.

## Design considerations

Keep one required path small enough for routine edits. Broader compatibility jobs may run on a schedule, while release candidates receive the full supported matrix.

## Example

```text
matrix: { node: [20, 22], os: ["linux", "macos"] }
```


## Practical details

For routine changes, choose one representative runtime on each supported operating system, then cover the remaining runtime in a scheduled job. A release candidate can run every supported combination. Record which risk each row covers so an added feature flag is not multiplied into unrelated jobs. Compare queue time and failures by row; remove redundant combinations only when their coverage is supplied elsewhere.
