---
title: Application logging
aliases: [gunluk]
status: active
generated: 2020-01-01
stale_after: P30D
---
# Application logging

## Procedure
The team uses this guide when working on application logging. Before making a change, identify the owner and inspect the current system state. The main operational step is to attach request identifiers and remove credentials from log records. If the check fails, stop the rollout and record the evidence for investigation.

## Verification
Repeat the check in a representative environment before approving production use. Record the outcome and the responsible operator in the change history. Review the procedure again after an incident or a change in dependencies.
