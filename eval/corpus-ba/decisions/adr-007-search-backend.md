---
title: ADR-007 search backend
status: superseded
superseded_by: decisions/adr-011-search-backend.md
generated: "2025-06-06"
---
# ADR-007 search backend

## Decision
Search scans the markdown files on each request and ranks matches with a simple term count. No index is kept between requests.

## Context
The knowledge base was small, and a scan was fast enough to meet the interactive budget. Keeping the implementation trivial made it easy to audit.

## Status
This decision was superseded by [[decisions/adr-011-search-backend]] once the knowledge base grew past the scan budget. It remains here as the record of the earlier approach. Ranking details of the replacement are in [[architecture/search-ranking]].

## Consequences
Scanning cost grew with the number of pages, and latency targets were missed for large vaults.

## Alternatives considered
A persistent index file was considered at the time but rejected because it required a migration step on every upgrade. The team preferred the simpler scan and accepted the cost until the vault size made the cost visible.

## Operational notes
Scans were run inside the request handler, so a slow disk affected every query. The team measured the scan time on the smallest supported node and recorded the number in the review notes for later comparison.
