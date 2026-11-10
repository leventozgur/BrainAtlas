---
title: Rollout policy
status: active
generated: "2026-04-02"
---
# Rollout policy

Every release rolls out in three stages: ten percent of service nodes, fifty percent, and then the remainder. Each stage waits for a soak period of at least thirty minutes before the next stage starts. The soak period is long enough to surface slow leaks and most queue regressions.

## Rollback criteria
A stage is rolled back when the error rate rises above twice its pre-release baseline, when the backlog panel shows sustained growth for more than fifteen minutes, or when any safety check fails. Rollback uses the previous release bundle and does not require a rebuild.

## Communication
The release owner posts the stage, the time, and the observed metrics in the operations channel. Changes that affect the on-call procedure are also described in [[ops/oncall]].

## Exceptions
Security fixes may skip the fifty percent stage with the approval of the security lead. Such exceptions are recorded in the release notes so that the deviation is visible later.
