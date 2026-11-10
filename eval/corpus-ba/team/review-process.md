---
title: Review process
status: active
generated: "2026-01-19"
---
# Review process

Every change to the shared services needs one approving review from a code owner. Changes that touch the backup system or the retention table need a second approval from the platform lead, because their mistakes are hard to undo.

## Requests from other teams
Requests for data restores, retention exceptions or access changes go through the ticket queue. Each ticket states the reason, the requested scope and the expiry date. The platform team answers within two working days.

## Review standards
Reviews check tests, rollback notes and the documentation impact. A change that alters an operational procedure must update the matching runbook in the same pull request.

## Escalation
Disagreements that cannot be resolved in review are raised in the weekly engineering meeting. The decision is recorded as an ADR so that the reasoning stays available.

## Documentation
Pull requests that change behaviour described in the knowledge base must update the matching page in the same change. Reviewers check the frontmatter dates and the links, not only the prose.
