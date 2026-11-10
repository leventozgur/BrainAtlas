---
title: Restore drill
status: active
generated: "2026-06-25"
---
# Restore drill

The restore drill runs once per quarter. The team restores the most recent daily snapshot into the staging environment, runs the integrity queries, and compares row counts with the production figures captured at the start of the drill. The result is written into a short drill report.

## Steps
Start from the snapshot list described in [[ops/backups]]. Select the snapshot taken closest to the scheduled drill time, not the newest one, so that the drill tests a snapshot that has aged. Restore into an isolated network segment and never connect the restored store to live queues.

## Report
The drill report lists the snapshot identifier, the restore duration, the integrity results and any manual steps that were needed. Gaps between the drill and the documented procedure are filed as tasks with an owner and a due date.

## Retention interplay
Drill reports themselves follow the retention table in [[data/retention]].
