---
title: Pagination cursors
status: active
---
# Pagination cursors

## Procedure
The team uses this guide when working on pagination cursors. Before making a change, identify the owner and inspect the current system state. The main operational step is to use stable cursors when traversing changing datasets. If the check fails, stop the rollout and record the evidence for investigation.

## Verification
Repeat the check in a representative environment before approving production use. Record the outcome and the responsible operator in the change history. Review the procedure again after an incident or a change in dependencies.
