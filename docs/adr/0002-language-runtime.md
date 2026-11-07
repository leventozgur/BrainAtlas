# ADR 0002: Language and runtime

- Status: Accepted, 2026-11-08

## Context
The product needs a small local footprint and straightforward distribution across supported coding agents.

## Decision
Use Node.js 20 or newer, ESM JavaScript with JSDoc, node:test, and no build step. Rust and Python were rejected for the initial worker runtime because they add separate toolchains or runtime packaging. Reopen if hook p95 exceeds 300 ms or the target reaches 10k+ pages. Harden npm supply chain with lockfile review and scripts disabled in CI.

## Consequences
Native dependencies are excluded; APIs remain simple and directly executable.

## Alternatives
Rust could improve startup/CPU efficiency; Python could ease NLP prototyping but adds runtime variability.
