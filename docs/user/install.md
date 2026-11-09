# Install and verify

BrainAtlas requires Node.js 20 or newer. The release installer supports macOS and Linux and requires `ssh-keygen` for signature verification.

## Build a distribution folder

From a BrainAtlas checkout, create a self-contained distribution folder. It contains Lite and Full archives, the installer, a `release/` install kit and checksums:

```sh
node release/build-release.mjs --version <v> --out <dir>
```

The output includes `brainatlas-<v>-lite.tgz`, `brainatlas-<v>-full.tgz`, `install.sh`, `release/`, and `SHA256SUMS`. Sign the checksum list with the release signing key:

```sh
ssh-keygen -Y sign -n brainatlas-release -f <private-key> SHA256SUMS
```

This creates `SHA256SUMS.sig`. Distribute the complete folder, including `release/allowed_signers`, to the installation host. Do not publish a signing private key.

## Online acquisition

Releases are published on GitHub Releases: https://github.com/leventozgur/BrainAtlas/releases. GitHub Release assets cannot preserve subdirectories. Download `brainatlas-<v>-distribution.tar.gz`, extract it into an empty directory, and run the installer there. The individual release files contain the same content, but must be arranged with the original directory structure. Verify the maintainer key fingerprint `SHA256:PPcml0QiRHQJrtPnqWMXF77PgJhPT27GOHboOMJCw40` against `release/allowed_signers` before the first install.

## Install from the distribution folder

Run the installer while in the copied distribution folder. No other checkout is needed:

```sh
sh install.sh --from brainatlas-<v>-lite.tgz --allowed-signers release/allowed_signers --yes
brainatlas doctor
```

To select a vault during installation, add `--vault PATH`. The installer verifies the signed checksums and archive before extraction. Installation directories reached through symlinks that resolve outside `HOME` are rejected by default; use `--allow-symlinked-root` only when that layout is intentional.

Replace `<v>` with the actual version. Run `brainatlas doctor` to check installation and configured adapters. Doctor module-health rows are warnings and do not make overall `ok:false`.

## Manage releases

- Update from a verified archive: `brainatlas update --from <archive>`.
- Check an archive: `brainatlas update --check --from <archive>`.
- Roll back to the prior release: `brainatlas rollback`; choose a specific installed version with `brainatlas rollback --to <version>`.
- Preview supported operations with `--plan`.
- Uninstall with `brainatlas uninstall`. The configured vault is preserved.

See [Agent setup](agents.md) for adapter configuration and trust review.
