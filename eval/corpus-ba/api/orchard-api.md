---
title: Orchard API
status: active
generated: "2026-07-15"
---
# Orchard API

The Orchard API exposes catalog reads, change streams and administrative endpoints. Every list endpoint is paginated with a cursor, and every stream can be resumed from the last acknowledged cursor.

## Pagination
List endpoints return a cursor with each page. Pass the cursor back to receive the next page. Cursors expire after 24 hours, and an expired cursor produces a clear error that asks the caller to start again from the first page. Pagination is cheap, so clients should not cache whole result sets.

## OrchardClient.resumeStream
resumeStream reopens a change stream from the last acknowledged cursor. Use it after a network drop instead of restarting the sync from the beginning, which would replay the whole catalog. The method returns the cursor it resumed from so that the caller can log the gap.

## Limits
Anonymous access is not supported. Authenticated clients receive the rate limits listed in [[faq/rate-limits]]. Sync behaviour that uses these endpoints is described in [[architecture/orchard-sync]].
