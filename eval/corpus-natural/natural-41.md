---
title: "Binary compatibility in a shared module"
status: "active"
generated: "2026-10-01"
stale_after: "2025-01-01"
---

# Binary compatibility in a shared module

## Context

A module can keep its source API stable while changing a serialized representation that downstream tools depend on. Compatibility review should inspect public exports, data shape, and runtime assumptions separately. A small consumer fixture often reveals accidental coupling.

## Design considerations

Version the persisted format when old readers cannot safely ignore new fields. Migration code should remain available for the documented support window and have a clear failure path.

## Example

```text
export { parseRecord, FORMAT_VERSION }
```


## Practical details

Give the serialized representation an explicit format version and reject unknown incompatible versions with an actionable error. Provide a migration from the previous supported version and keep a fixture for each supported reader. A field that older readers reject cannot safely be introduced as an unversioned optional addition. Test a round trip through the migration and document the point at which support for the old format ends.
