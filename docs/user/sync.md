# Sync

Synchronization is optional and belongs to Full/Custom modules. Review where vault files will be stored and how credentials are handled before enabling it. No application key is embedded in the repository.

## Command syntax

With `sync-engine` enabled, the supported commands are:

```text
brainatlas sync run [--json]
brainatlas sync status [--json]
brainatlas sync check --peer STATE_DIR [--json]
brainatlas sync approve <path> | --all
brainatlas sync pause
brainatlas sync resume
```

When the Git sync module is also enabled, it adds:

```text
brainatlas sync git status [--json]
```

`approve <path>` approves one reviewed pending deletion; `approve --all` approves all pending deletions. The sync commands are available only after installing a Full release and enabling `sync-engine`.

## GitHub with a private repository and SSH

Use an empty **Private** GitHub repository (do not initialize it with a README). Vault content is stored in that repository. BrainAtlas filters supported writes for secret-like content, but this is not a complete secret scanner and there is no client-side encryption. Keep the repository private and review what you sync.

1. Create a separate SSH key for each host, or use an account SSH key. Add each key to the private repository as a deploy key and enable **Allow write access**, or add it to the account that can write to the repository. Do not reuse one private key by copying it between hosts.
2. On each host, configure SSH so Git can use that key without an interactive prompt. Check access with `ssh -T git@github.com` and accept the host key only after verifying it through your normal SSH trust process.
3. Set the Git transport and remote. Replace `<owner>` and `<repo>` with the repository path:

   ```sh
   brainatlas config set sync.transport git
   brainatlas config set sync.options.remote git@github.com:<owner>/<repo>.git
   ```

   The branch defaults to `main`. Set `sync.options.branch` if the repository uses another branch. An empty remote is initialized on the first sync. HTTPS URLs containing tokens are discouraged; credentials in such URLs trigger a warning and are redacted from output.
4. On the first host, upload the vault:

   ```sh
   brainatlas sync run
   brainatlas sync status
   brainatlas sync git status --json
   ```

5. On the second host, install BrainAtlas, configure the same private remote and run `brainatlas sync run` to pull and reconcile the shared data. Give hosts distinct identities with `brainatlas config set sync.options.hostId <host-name>` if useful; otherwise BrainAtlas keeps a stable generated host identity.
6. Check peer consistency by passing the other host's state directory:

   ```sh
   brainatlas sync check --peer <stateDir>
   ```

   Review any findings. Use `brainatlas sync approve <path>` only for a specific pending deletion you have reviewed, or `brainatlas sync approve --all` to approve all pending deletions. `brainatlas help sync` also shows the commands available in the enabled modules.

Git uses SSH BatchMode, so configure keys and agent access before running sync. Sync can retain unresolved conflicts for review; deletions require approval.

## Dropbox alternative

Dropbox is an optional object transport. It uses the host's credential facilities where supported and conditional revision updates. Review the credentials and destination before enabling it. Sync moves vault data to the configured destination.

## Folder transport

Folder sync is experimental; do not rely on it for production data.
