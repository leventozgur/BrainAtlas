---
title: Secrets policy
status: active
generated: "2026-04-16"
---
# Secrets policy

Secrets are stored only in the approved secret manager. They are never committed to repositories, pasted into tickets, or included in documentation. Examples in documentation use placeholder values such as the word example or a row of x characters, so that readers cannot mistake them for working credentials.

## Rotation
Signing keys and service credentials are rotated every quarter. The rotation owner announces the window in the operations channel and confirms that old credentials were revoked. Emergency rotation follows the same steps and is recorded in the incident report.

## Detection
A repository scanner blocks commits that contain credential-shaped strings. Findings are triaged within one working day. A finding that turns out to be real starts the rotation process immediately, even if the value was only visible in a private branch.

## Access
Access to the secret manager is granted through the access review in [[security/access-review]]. Token formats and lifetimes are described in [[api/auth-tokens]].
