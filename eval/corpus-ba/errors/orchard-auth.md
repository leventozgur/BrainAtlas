---
title: Orchard authentication errors
status: active
generated: "2026-06-21"
---
# Orchard authentication errors

## E_ORCHARD_AUTH_EXPIRED
The Orchard client raises E_ORCHARD_AUTH_EXPIRED when the bearer credential it holds is past its validity window. The client does not retry the request with the same credential. Instead it asks the token endpoint for a fresh credential once, and if that also fails it reports the error to the caller with the request identifier.

## What to check
Confirm the clock on the host is synchronised, because a skewed clock makes valid credentials look expired. Confirm that the refresh step ran during the last sync cycle. The lifecycle of these credentials is described in [[api/auth-tokens]].

## Logging rules
The error message contains the identifier of the credential, never its value. Log lines must not include the header that carries the credential. Incidents that involve this error follow the secrets policy in [[security/secrets-policy]].

## Retry policy
A single refresh attempt is made per request. If the refresh fails, the caller receives the error immediately, so that a burst of requests does not flood the token endpoint.
