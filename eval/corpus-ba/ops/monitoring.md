---
title: Monitoring runbook
status: active
generated: "2026-08-28"
---
# Monitoring runbook

The monitoring dashboards show request latency, error rates, queue backlog and sync lag. Each panel has a link to the runbook section that explains what a healthy value looks like and what to do when the value drifts.

## Alerts
Alerts route to the current on-call engineer. An alert that stays unacknowledged for fifteen minutes is escalated to the secondary, as described in [[ops/oncall]]. Alert thresholds are reviewed every quarter.

## Backlog panel
The backlog panel is the first place to look after a pause or a deploy. A backlog that grows during a sync pause is expected and clears within one sync interval. A backlog that keeps growing after the sync resumes points to a stuck consumer, see [[errors/queue-locked]].

## Webhook deliveries
Failed webhook deliveries appear as a delivery backlog alert. The alert names the subscription, not the receiver's address, and the retry schedule is part of this runbook. Subscriptions that stay failed are paused as described in [[api/webhooks]].

## Mail notices
Notices that depend on the mail provider are tracked through [[vendors/mailroom-provider]], and a provider outage shows up in the backlog panel described above.
