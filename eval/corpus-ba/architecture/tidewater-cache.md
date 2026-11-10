---
title: Tidewater cache
status: active
generated: "2026-09-10"
aliases: [tidewater, read cache]
---
# Tidewater cache

Tidewater is the read-through cache placed in front of catalog lookups. It keeps recently read entries in memory on each service node and shares invalidation events through the queue.

## Update 2025-01-10 — TTL set to 300 seconds
Entries expire after 300 seconds. At the traffic level of that period, stampedes on popular keys were rare and the simple expiry rule was enough.

## Update 2025-06-02 — TTL raised to 600 seconds
After the catalog grew, the TTL was raised to 600 seconds to reduce load on the origin database. Invalidation events still clear entries immediately when the catalog changes.

## Current state (2026-09)
The TTL is 900 seconds. Entries past their TTL are served for up to TIDEWATER_STALE_GRACE seconds while one request refreshes them in the background. The default grace is 60 seconds. Invalidation follows [[decisions/adr-005-cache-invalidation]]. The February stampede that motivated the grace period is described in [[ops/incident-2026-02-cache-stampede]].
