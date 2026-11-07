# ADR 0003: Vendored llmwiki-core

- Status: Accepted, 2026-11-08

## Context
The project needs a stable baseline of upstream wiki functionality.

## Decision
Vendor Microsoft llmwiki packages/core v1.0.1 under its MIT license. BrainAtlas owns BM25F retrieval.

## Consequences
Upstream source is pinned and notices are preserved.

## Alternatives
A live dependency would increase supply chain drift; the upstream search implementation does not define our evidence scoring.
