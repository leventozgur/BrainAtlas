---
title: Rate limits
status: active
generated: "2026-08-30"
---
# Rate limits

API rate limits protect the shared service from bursts. Limits apply per client and per endpoint group, and the response headers tell the client how many requests remain in the current window.

## Update 2025-04-01 — 60 requests per minute
The first public limit was 60 requests per minute for every authenticated client. Sync jobs that paged through large catalogs hit the limit during full rebuilds.

## Current state (2026-08) — 120 requests per minute for authenticated clients
Authenticated clients now receive 120 requests per minute. The window is sliding, so a short burst is allowed when the average over the window is low. Sync jobs use the cursor endpoints described in [[api/orchard-api]] to stay under the limit.

## Exceeding the limit
A client that exceeds the limit receives a throttling response with a retry hint. Clients should honour the hint instead of retrying immediately, which would only extend the throttling period.
