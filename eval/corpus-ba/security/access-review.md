---
title: Access review
status: active
generated: "2026-04-22"
---
# Access review

## Update 2025-02 — semi-annual review
Access to production systems was reviewed twice a year. Each team lead signed off on the list of members and their roles, and removals were applied within a week of the sign-off.

## Current state (2026-04) — quarterly review
Access is now reviewed every quarter. Team leads and the security lead both sign the list, and any account without a recent login is flagged for removal. The shorter cycle was introduced after two contractor accounts stayed active longer than planned.

## Process
The review list is generated from the identity provider and compared with the on-call roster. Differences are resolved before sign-off. Access to the secret manager follows the rules in [[security/secrets-policy]].

## Evidence
The signed list is stored with the quarterly records, and the retention of those records follows [[data/retention]].

## Exceptions
An access exception is granted for a fixed period and must name the reason and the approver. Exceptions that are not renewed at the next review expire automatically, and the expiry is logged.
