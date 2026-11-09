---
title: "Process versus procedure"
status: "active"
generated: "2026-10-01"
stale_after: "2025-01-01"
aliases: ["Process reference"]
---

# Process versus procedure

## Context

An operating system process is a running program with an address space and scheduling state. A procedure is an ordered set of instructions people or automation follow to complete a task. The shared everyday word does not make the technical concepts interchangeable.

## Design considerations

Search guidance can use nearby terms such as PID, memory, and scheduler for the first meaning, while checklist and approval steps point toward the second.

## Example

```text
processId = child.pid
```


## Practical details

To inspect a child process identifier, read `child.pid` after the operating system has started it; the value identifies that running process, not a written procedure. On a command line, a process listing can show identifiers alongside command names. A PID may be reused after exit, so it should not be treated as a permanent identity. Check whether the child has exited before using an old identifier for another operation.
