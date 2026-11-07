# ADR 0001: Infrastructure

- Status: Accepted, 2026-11-08

## Context
BrainAtlas needs a local Markdown vault, MCP access, agent integrations, optional modules, and evidence freshness.

## Decision
Build a workspace skeleton with a core package, adapters, MCP and hook packages, and independent modules. The design patterns informed by avenoxbeyin are credited; no code is copied. MCP, OKF, and CAS sync are BrainAtlas work.

## Consequences
The first release can evolve contracts independently while preserving explicit ownership boundaries.

## Alternatives
A monolith would couple editor integrations and storage transports.
