---
title: Testing guide
status: active
generated: "2026-03-09"
---
# Testing guide

The test suite runs with the Node built-in test runner and needs no extra dependencies. Unit tests live next to the code they cover, and acceptance tests live in a separate tree that mirrors the product requirements. Every new behaviour needs at least one test that fails before the change.

## Fixtures
Fixtures are created in temporary directories and removed when the test finishes. Tests must not depend on the real home directory, network access or the system clock. Time-dependent behaviour takes an explicit timestamp argument.

## Adapter tests
The widget adapter is tested with a recorded fixture, as described in [[architecture/widget-module]]. Upstream calls are never made from the test suite.

## Running
Run the full suite before opening a pull request. The guard script checks for absolute paths, forbidden APIs and licence headers. Failures in the guard are blocking.

## Flaky tests
A test that fails only on some runs is quarantined and reported in the weekly engineering meeting. Quarantined tests keep running in a separate job so that the cause can be found without blocking every change.
