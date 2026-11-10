---
title: Widget module layout
status: active
generated: "2026-04-11"
---
# Widget module layout

The widget adapter lives at src/lib/widget.mjs inside the Orchard monorepo. The file exports a single client factory that wraps the upstream call, applies the timeout window, and returns typed results to callers. Callers should not import the internal retry helper directly, because the helper changes with the upstream protocol and its signature is not stable.

## Responsibilities
The module validates batch size before sending, splits oversized batches, and maps upstream status codes to the error names documented in [[errors/widget]]. It does not hold state between calls, which keeps it safe to use from several queue consumers at once.

## Tests
Unit tests for the module sit next to the monorepo test runner. Integration checks use a recorded fixture and never contact the real upstream. The testing conventions are summarised in [[guides/testing]].

## Ownership
The module is owned by the platform team. Changes to the batch limit need a review from the owner of the delivery worker so that both sides agree on the maximum size.
