---
title: "Release artifact reproducibility"
status: "active"
generated: "2026-10-01"
stale_after: "2025-01-01"
keywords: ["Release", "reference"]
---

# Release artifact reproducibility

## Context

A reproducible artifact can be rebuilt from a declared source revision and toolchain with matching output hashes. Pinning dependencies and normalizing archive timestamps removes common sources of noise. The claim should state what is compared, since signatures and embedded build times may vary.

## Design considerations

A clean-room build is stronger evidence than a successful local rebuild. Keep the manifest beside the artifact so a reviewer can inspect inputs without relying on a workstation cache.

## Example

```text
sha256sum release.tar
```


## Practical details

Two isolated release jobs should build the same source revision with identical declared tools, then compare the unsigned archive using `sha256sum`. Matching digests support byte-for-byte equality for those outputs; they do not prove the source is trustworthy. Sort archive entries and fix timestamps before packaging. If hashes differ, inspect the manifests and unpacked file metadata to locate nondeterministic inputs before publishing the result.
