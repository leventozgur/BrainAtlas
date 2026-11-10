---
title: Webhooks
status: active
generated: "2026-05-12"
---
# Webhooks

Orchard sends webhook events for catalog changes. Each delivery carries a unique event identifier so that receivers can deduplicate events that arrive twice. Receivers must verify the signature header before they process the body, and they should reject deliveries whose timestamp is outside the accepted window.

## Delivery behaviour
Deliveries are sent in the order the changes were committed, but a receiver must not depend on strict ordering across different catalog items. Failed deliveries are retried on the schedule described in the monitoring runbook ([[ops/monitoring]]). A subscription that keeps failing is paused and an owner is notified.

## Testing
A sample payload can be sent to a test endpoint from the administrative console. The sample uses placeholder values only and never contains production data.

## Related
The bearer credentials used for subscription management follow the rules in [[api/auth-tokens]].

## Replay
Receivers can ask for a replay of events from a given time. Replays reuse the original event identifiers, so deduplication keeps working. Replays are limited to the retention window of the event log.
