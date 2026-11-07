---
contract-version: 1
---
# Release contract

## Purpose

Define reproducible release artifacts, their signed checksums, archive layout, and verification order.

## Function signatures

```js
/** @param {{version:string,profile:'lite'|'full',modules:string[],builtAt:string}} options @returns {Promise<string[]>} */
export async function buildRelease(options);
/** @param {string} archivePath @param {string} checksumPath @param {string} signaturePath @returns {Promise<ReleaseManifest>} */
export async function verifyRelease(archivePath, checksumPath, signaturePath);
```

Artifacts are `brainatlas-<v>-lite.tgz`, `brainatlas-<v>-full.tgz`, `SHA256SUMS`, `SHA256SUMS.sig`, and `install.sh`. Sign with `ssh-keygen -Y sign -n brainatlas-release`. `release/allowed_signers` uses ssh-keygen allowed-signers format.

## Input

The archive root is `brainatlas-<v>/` and contains `package.json`, `packages/`, `modules/`, `vendor/`, `node_modules/`, and `release-manifest.json`. The manifest is `{name,version,profile,modules,files:[{path,sha256}],builtAt}`. Archive entries are sorted and use fixed mtimes.

## Output and errors

Verification order is SHA-256 checksums, signature and signer namespace, then manifest file inventory and per-file hashes. Reject missing files, profile mismatch, and path traversal. Verification returns the validated manifest; failures use stable `E_*` error codes.

### Errors

- `E_SHA_MISMATCH`: an artifact or manifest file hash differs from its recorded checksum.
- `E_SIGNATURE_INVALID`: the signature or signer namespace is invalid.
- `E_MANIFEST_INVALID`: the release manifest is malformed or its file inventory is invalid.
- `E_PROFILE_MISMATCH`: the selected profile does not match the release manifest.
- `E_MODULE_MISSING`: a module required by the manifest is absent from the archive.

## Example

```text
brainatlas-0.1.0-lite.tgz
SHA256SUMS
SHA256SUMS.sig
```

## Security

Only trusted signing keys may install releases. Do not run package lifecycle scripts during installation; validate archive paths before extraction.

## Version

Release manifest and artifact layout above are contract version 1. Builder and verifier are owned by `release/`.
