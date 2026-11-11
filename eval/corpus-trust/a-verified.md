---
title: "Backup key rotation policy"
type: concept
status: confirmed
generated: "2026-01-10"
sources:
  - "wiki/sources/trust-dev.md"
verified:
  - date: "2026-01-12"
    evidence: "dev fixture review"
    scope: "Backup key rotation policy"
    source: "wiki/sources/trust-dev.md"
aliases: []
keywords: []
---
# Backup key rotation policy

The vault backup encryption key is rotated on a fixed cadence and the retired key is kept until one restore test passes.
