---
title: "Configuration precedence rules"
status: "active"
generated: "2026-10-01"
stale_after: "2025-01-01"
---

# Configuration precedence rules

## Context

When defaults, a file, environment values, and command-line flags overlap, precedence must be explicit. Parse each source into a typed object, then merge in documented order so a string value does not accidentally replace a numeric option.

## Design considerations

Show the selected source for non-sensitive settings in diagnostics. For secret values, report only whether a source was configured; never print the value itself.

## Example

```text
effective = merge(defaults, file, env, flags)
```


## Practical details

A practical precedence order is defaults, configuration file, environment, then command-line flag, with later sources overriding earlier ones. Thus a flag set to four wins over an environment value of two. Parse and validate the final typed value before starting work; distinguish an absent flag from an explicitly supplied false value. Diagnostics may show the winning source for a timeout, while secret settings reveal only that a value exists.
