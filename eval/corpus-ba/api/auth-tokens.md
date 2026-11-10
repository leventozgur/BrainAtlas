---
title: Auth tokens
status: active
generated: "2026-06-08"
---
# Auth tokens

Tokens are short-lived bearer credentials issued by the token endpoint. A client receives a token together with its expiry time and should refresh the token before that time. Refreshing early avoids a failed request at the boundary, which is the most common cause of avoidable errors in sync jobs.

## Expiry
An expired token produces E_ORCHARD_AUTH_EXPIRED, described in [[errors/orchard-auth]]. The client does not keep retrying with an expired token, because the server counts those attempts as suspicious.

## Handling secrets
Tokens must never be written to logs, tickets, chat messages or documentation examples. Examples in this knowledge base use placeholder text only. The signing key is rotated on the schedule in [[security/secrets-policy]].

## Scope
A token carries the scopes granted to its client. Requests outside those scopes fail with a permission error, not an authentication error, so the two failures can be told apart in dashboards.

## Renewal schedule
Renewal jobs run a few minutes before the expiry time they read from the token response. A job that finds its token already expired records the event and asks the operator to check the clock. Repeated expiry in one job is treated as a configuration problem, not as a transient network error.
