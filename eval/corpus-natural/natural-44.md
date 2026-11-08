---
title: "Disputed evidence handling"
status: "disputed"
generated: "2026-10-01"
stale_after: "2025-01-01"
---

# Disputed evidence handling

## Context

When two sources disagree, a memory system should preserve both claims and describe the unresolved question. Marking one page as disputed prevents a search result from appearing more certain than the evidence warrants.

## Design considerations

Resolution requires a specific observation, not a vote based on which wording sounds familiar. Once settled, retain the prior account with a superseding link so the change remains auditable.

## Example

```text
status: disputed
question: "Which format is emitted?"
```


## Practical details

Suppose one report observes a retry and another observes no retry under a similar error. Keep both observations, including their versions and conditions, and mark the unresolved claim as disputed. A targeted experiment can distinguish a timeout from a permanent failure. Search results should expose the disagreement instead of presenting either report as settled fact. After resolution, link the newer explanation while retaining the earlier observations.
