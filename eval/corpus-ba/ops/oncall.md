---
title: On-call rotation
status: active
generated: "2026-05-04"
---
# On-call rotation

## Current state (2026-05)
The primary and secondary on-call engineers rotate weekly, with the handover on Monday morning. The primary responds to alerts first. The secondary covers deploys and takes over when the primary is unavailable. Each engineer confirms the handover in the operations channel.

## Escalation
An alert that is not acknowledged within fifteen minutes escalates to the secondary. An alert that is not acknowledged within thirty minutes escalates to the engineering manager. Escalations are logged so that response times can be reviewed at the monthly meeting.

## Deploys during handover
Deploys that overlap a handover need the agreement of the incoming primary. The freeze schedule that applies to these overlaps is in [[ops/deploy-window]]. Incidents that start during a handover follow the monitoring guidance in [[ops/monitoring]].

## Handover checklist
The outgoing primary lists open alerts, pending deploys and any manual steps still running. The incoming primary confirms each item in the channel. A handover without confirmation is recorded as incomplete and reviewed at the monthly meeting.
