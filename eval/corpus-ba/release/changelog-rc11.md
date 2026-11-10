---
title: Changelog rc.11
status: active
generated: "2026-08-20"
---
# Changelog rc.11

Release candidate rc.11 was cut from the release commit a1b2c3d after the regression suite passed on all supported platforms. The notes below summarise the user-visible changes and the operational steps that accompany them.

## Added
Widget calls now apply jitter to their retry delays, which reduces synchronised retries during upstream recovery. See [[errors/widget]] for the error codes that these retries cover.

## Fixed
A late heartbeat no longer produces a false E_QUEUE_LOCKED error when the consumer is still healthy. The fix extends the grace period for heartbeats that arrive during a garbage collection pause.

## Operations
Rollout follows the staged policy in [[release/rollout-policy]]. Operators should watch the backlog panel for the first hour after each stage, because the fix changes how long locks survive.

## Known limits
The dead-letter rename is not part of this release and is tracked in [[architecture/larkspur-queue]].

## Upgrade notes
No configuration changes are required. Operators who pinned the retry jitter to a fixed value should remove the pin, because the default now handles the same case without it.
