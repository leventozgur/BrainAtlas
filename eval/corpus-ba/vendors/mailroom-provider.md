---
title: Mailroom provider
status: active
generated: "2026-04-08"
aliases: [mail vendor, transactional mail]
---
# Mailroom provider

Mailroom is the external provider that sends transactional email for account and billing notices. The integration uses a single API key stored in the secret manager, and that key is rotated with the other service credentials described in [[security/secrets-policy]].

## Current state (2026-04)
Mailroom is used only for transactional messages. Marketing mail is sent by a different provider and is out of scope here. Bounce handling is automatic, and hard bounces remove the address from the notification list after one notice.

## Contract notes
The contract is reviewed annually by the procurement team. Usage reports are reviewed each month, and a sustained rise in message volume triggers a review of the sending rules.

## Failure behaviour
If the provider is unavailable, notices are queued for up to a day and then dropped with a log entry. The queue is monitored through [[ops/monitoring]].

## Testing
Test accounts use placeholder addresses on a reserved domain. Test messages are never sent to real customers, and the sandbox mode of the provider is used for every integration test.
