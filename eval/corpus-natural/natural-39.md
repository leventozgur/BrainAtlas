---
title: "Unit test isolation without a real home"
status: "active"
generated: "2026-10-01"
stale_after: "2025-01-01"
---

# Unit test isolation without a real home

## Context

A test that reads the developer home directory can pass locally and fail on another machine for reasons unrelated to the code. Inject `HOME` and XDG locations into a child process and point them at a fresh temporary tree.

## Design considerations

The test owns the fixture lifecycle and removes it even after an assertion fails. No process should scan the real profile merely to discover optional settings.

## Example

```text
env: { HOME: tempHome, XDG_CONFIG_HOME: configRoot }
```


## Practical details

Create a fresh temporary directory for each test and pass it as both `HOME` and `XDG_CONFIG_HOME` to the child process. Place a harmless marker in the isolated tree and verify that optional settings are resolved there. Remove the tree in a `finally` block even when the child fails. Parallel cases need separate directories, and the test must not depend on any real profile file being present.
