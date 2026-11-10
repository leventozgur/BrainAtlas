---
title: Backups
status: active
generated: "2026-07-07"
---
# Backups

A full snapshot of the catalog store is taken once per day, during the quietest window of the night. Incremental snapshots run every six hours between full snapshots. Snapshots are encrypted at rest and copied to a second region, so that a regional outage does not remove every copy.

## Retention
The backup system keeps seven daily snapshots and four weekly snapshots. Older snapshots are removed automatically by the scheduler. The retention of application records is a separate policy described in [[data/retention]].

## Verification
Each snapshot is checked for completeness when it is written. A snapshot that fails the check raises an alert and does not replace the previous good snapshot. The check does not prove that the data can be restored, which is the purpose of the drill in [[ops/restore-drill]].

## Access
Only the platform on-call group can start a manual restore. Requests from other teams go through the ticket process in [[team/review-process]].
