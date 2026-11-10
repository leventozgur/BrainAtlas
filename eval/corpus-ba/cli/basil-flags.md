---
title: Basil flags
status: active
generated: "2026-06-18"
aliases: [basil options, command flags]
---
# Basil flags

Basil is the command line tool used for Orchard maintenance. Common flags include --dry-run, which prints the planned actions without running them, --verbose, which adds timing lines, and --drain-timeout, which bounds how long a shutdown waits for running work.

## Update 2025-08-01 — drain timeout default 30 seconds
The default for --drain-timeout was 30 seconds. Long catalog runs were cut short during deploys, which led to repeated restarts and noisy alerts.

## Current state (2026-06) — drain timeout default 45 seconds
The default for --drain-timeout is 45 seconds. A sync run that is still active at the timeout is paused at its next checkpoint and resumed by the next process, as described in [[architecture/orchard-sync]]. Use --dry-run first to preview which runs a shutdown will pause.

## Other options
The doctor subcommand accepts a repair flag for stale locks. Lock errors and their meaning are listed in [[errors/basil-errors]]. Installation options are covered in [[cli/basil-install]].
