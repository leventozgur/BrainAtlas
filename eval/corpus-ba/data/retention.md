---
title: Data retention
status: active
generated: "2026-10-12"
---
# Data retention

Retention periods define how long each class of data is kept before automatic deletion. The table is reviewed twice a year, and any change is recorded below with its date so that earlier periods remain visible to auditors.

## Update 2025-03-01 — audit logs kept 180 days
Audit log entries were kept for 180 days. This matched the minimum that the internal review asked for at the time.

## Update 2026-01-15 — audit logs kept 365 days
The audit retention was extended to 365 days after a customer audit requested a full year of history.

## Current state (2026-10) — audit logs kept 400 days
Audit log entries are kept for 400 days, and support tickets are kept for two years. Backups follow their own schedule in [[ops/backups]]. The restore drill checks that data outside the retention window is not reappearing, see [[ops/restore-drill]].

## Deletion
Deletion runs nightly. Each deletion job writes a summary line with counts and no record contents.
