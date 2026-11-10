---
title: Basil error reference
status: active
generated: "2026-05-30"
---
# Basil error reference

## ERR_BASIL_LOCK_STALE
ERR_BASIL_LOCK_STALE means Basil found a lock file older than the stale threshold. Basil removes the file only when no live process carries the process identifier recorded inside it. If the recorded process is alive, Basil refuses to continue and prints the identifier so the operator can decide what to do.

## Recovery steps
Run the doctor subcommand to list every stale lock in the workspace. Review the list, stop any process that is still running, and then run the doctor subcommand again with the repair option. The repair option never touches locks that belong to a live process.

## Options
Options that change how long Basil waits before declaring a lock stale are listed in [[cli/basil-flags]]. Installation problems that look similar are covered in [[cli/basil-install]].

## Logging
Lock errors are logged with the lock file name and the recorded process identifier. The log never includes the contents of the lock file beyond those two values, which keeps the output safe to paste into a ticket.
