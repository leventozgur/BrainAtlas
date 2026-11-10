---
title: Quillstone logger
status: active
generated: "2026-06-03"
aliases: [quillstone, structured logger]
---
# Quillstone logger

Quillstone is the small structured logger used by every service in the monorepo. It writes one JSON object per line, supports four levels, and attaches the request identifier automatically when a request context is active.

## Levels
The levels are error, warn, info and debug. Production services run at info. Debug output is enabled per component for short investigations, and the change is reverted when the investigation ends.

## Output
Quillstone writes to standard output and to the rotating file described in [[ops/log-rotation]]. Field values are truncated and masked before writing, so the logger never records credential values.

## Roadmap
A sampling option for debug output is being designed. The design is not final and is not part of any release yet.

## Compatibility
Log lines keep the same field names across minor releases. Renaming a field is a breaking change and requires a notice in the release notes and an update to the shipper configuration.
