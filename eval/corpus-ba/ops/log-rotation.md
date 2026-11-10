---
title: Log rotation
status: active
generated: "2026-05-19"
---
# Log rotation

Service logs rotate once per day at midnight UTC. The previous day's file is compressed after the rotation completes, and compressed files are removed after fourteen days. The schedule keeps local disk usage predictable on the smallest node class.

## Structured fields
Each log line is a JSON object with a timestamp, a level, a component name and a request identifier. Free-text fields are truncated to a fixed size so that a single noisy request cannot fill the disk. Sensitive values are masked before they reach the file.

## Shipping
A shipper reads the rotated files and forwards them to the central store. The shipper keeps a cursor per file, so a rotation never causes lines to be shipped twice or skipped.

## Logging library
The Quillstone logger that produces these lines is described in [[projects/quillstone-logger]]. Alert rules that depend on log volume are listed in [[ops/monitoring]].
