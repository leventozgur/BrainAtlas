---
title: "Procedure: rotate a local test fixture"
status: "active"
generated: "2026-10-01"
stale_after: "2025-01-01"
---

# Procedure: rotate a local test fixture

## Context

The procedure for refreshing a local fixture begins by identifying the expected schema and preserving a small known-good sample. Replace generated values with synthetic equivalents, validate the new file, then compare the record count and required fields.

## Design considerations

This checklist is meant for repository test data. It does not describe rotating encryption keys, renewing a service credential, or changing a production account.

## Example

```text
node scripts/refresh-fixture.mjs --check
```


## Practical details

First copy the known-good fixture to a temporary location, then generate a replacement with synthetic records. Validate required fields and compare the number of rows with the expected sample before replacing the repository copy. Run the fixture-dependent test after replacement and inspect its diff for unexpected fields. If validation fails, retain the earlier sample and correct the generator; this sequence is a maintenance checklist rather than an operating-system process.
