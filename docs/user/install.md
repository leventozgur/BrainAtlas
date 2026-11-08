# Install and verify

BrainAtlas requires Node.js 20 or newer. The release installer supports macOS and Linux and requires `ssh-keygen` for normal signature verification.

## Online acquisition

The repository does not define a public download URL or online installer. Obtain the release archive, `SHA256SUMS`, `SHA256SUMS.sig`, and the trusted `release/allowed_signers` file from the project's verified release channel. **Verify before publishing:** document the canonical channel and exact verification commands here when they are established. Do not treat an archive downloaded from an unverified location as trusted.

After obtaining and verifying the files, run the installer against the archive:

```sh
./install.sh --from brainatlas-<v>-lite.tgz
brainatlas doctor
```

## Offline installation

Copy the signed Lite or Full `.tgz` to the target computer along with the matching signature files and allowed-signers file. The installer verifies the release before extracting it. By default it uses the adjacent `release/allowed_signers`; use `--allowed-signers <file>` to select the trusted signer list explicitly.

```sh
./install.sh --from brainatlas-<v>-lite.tgz --allowed-signers ./allowed_signers
brainatlas init --profile lite --agents claude-code,copilot-vscode,kiro
brainatlas doctor
```

Replace `<v>` with the actual version. The archive must match the requested profile. `--insecure-skip-signature` explicitly disables signature verification and should only be used when you accept that risk.

## Manage releases

- Update from a verified archive: `brainatlas update --from <archive>`.
- Check an archive: `brainatlas update --check --from <archive>`.
- Roll back to the prior release: `brainatlas rollback`; choose a specific installed version with `brainatlas rollback --to <version>`.
- Preview supported operations with `--plan`.
- Uninstall with `brainatlas uninstall`. The configured vault is preserved.

Run `brainatlas doctor` after installation or update. It reports installation and configured adapter checks.
