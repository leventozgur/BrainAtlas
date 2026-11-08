# Security checklist

Evidence is from static code review of the current checkout. No product code was changed.

| Check | Result | Evidence |
|---|---|---|
| `shell: true` | **Pass: none found.** The shared process helper explicitly disables shell interpretation. | `packages/core/src/util/index.mjs:86` |
| `eval` / `new Function` | **Pass: none found** in application code. | Search across `packages/`, `modules/`, `release/`, and `scripts/` |
| `child_process` arguments | **Pass.** Calls use argv arrays: shared `spawn(cmd, args)`, fixed `execFileSync` argument arrays, and `spawnSync(process.execPath, [cli,...])`. | `packages/core/src/util/index.mjs:63-87`; `packages/cli/src/index.mjs:176-179`; `modules/sync-dropbox/src/credentials.mjs:14-18`; `release/sign.mjs:6-8`; `release/build-release.mjs:119-121` |
| File write safety | **Mixed.** Atomic helper writes use a same-directory temporary file and rename; MCP paths are canonicalized and constrained before writes. Some scoped state, append, cache, transport, backup, and build writes are direct, non-atomic calls; see exceptions below. | `packages/core/src/util/index.mjs:8-20,22-61`; `packages/mcp/src/index.mjs:64-82,138-161`; `packages/core/src/vault/index.mjs:31-35,86-97`; `packages/core/src/retrieval/index.mjs:128-131`; `modules/sync-git/src/index.mjs:204-216`; `modules/sync-folder/src/index.mjs:171-184`; `release/build-release.mjs:108-112,143-153` |
| MCP write paths and contents | **Pass.** Write calls validate normalized relative path, deny globs, realpath containment, then check both `scanPath` and `scanText`; index, create, update and crosslink operations also scan generated output. | `packages/mcp/src/index.mjs:64-82,138-161,165-179,184-217` |
| Hook output redaction | **Pass.** Retrieved pieces and final context are redacted before output; bounded envelope then returns stdout. | `packages/hooks/src/index.mjs:99-117` |
| `--plan` output redaction | **Partial.** Init adapter change `before`/`after` strings are redacted by `redactPlanCopy`; redaction does not cover every plan payload. Install/update/uninstall/recover plans can include absolute target paths or journal values. | `packages/cli/src/index.mjs:310-322,544-545,596,601,625,672,723` |
| Network and offline controls | **Partial.** Dropbox and Ollama accept injected fetch implementations; Git remote commands, curl/wget, and CLI metadata checks respect `BRAINATLAS_OFFLINE`. CLI update metadata uses global `fetch` after an explicit offline check rather than an injected fetch dependency. | `modules/sync-dropbox/src/transport.mjs:48-70`; `modules/semantic/src/provider.mjs:26-53`; `packages/core/src/util/index.mjs:70-79`; `packages/cli/src/index.mjs:535-536,642-655` |

## Direct-write exceptions

These use path validation, exclusive creation, or scoped state where indicated, but do not use the atomic temporary-write helper at the write site:

- Vault initialization creates safe-resolved template paths with `flag: 'wx'`; log appends are direct append operations. `packages/core/src/vault/index.mjs:31-35,86-97`.
- Retrieval cache writes synchronously to the configured state directory and catches cache failures. `packages/core/src/retrieval/index.mjs:128-131`.
- Git object files are written directly after `ensureParents` checks path components and rejects symlinks/traversal. `modules/sync-git/src/index.mjs:190-216`.
- Folder transport writes directly after root/path containment and no-symlink rechecks; its comment explicitly does not promise atomic CAS. `modules/sync-folder/src/index.mjs:113-127,163-184`.
- Adapter backups and a few config migration backups use direct exclusive writes; managed target files generally go through `atomicWriteFile`. Examples: `packages/adapters/copilot-vscode/src/index.mjs:150-156,214-220`; `packages/adapters/gemini-cli/src/index.mjs:75-80`; `packages/adapters/kiro/src/index.mjs:123-130`; `packages/core/src/config/index.mjs:100-110,150-156`.
- Release archive and checksum outputs use direct writes to caller-selected output directory; verified extraction writes exclusive files into a newly-created destination after archive validation. `release/build-release.mjs:108-112,143-153`.
- Installer shim writes are managed and recorded but not atomic. `packages/cli/src/index.mjs:214-225`.

## Network scope

- Dropbox transport/OAuth and Ollama provider route requests through injected fetch parameters (defaulting to `globalThis.fetch`); callers can provide test/offline implementations.
- The CLI update metadata request is the sole application-level direct fetch call outside these provider modules. It is disabled under `BRAINATLAS_OFFLINE=1`, and requires an explicit metadata URL (`packages/cli/src/index.mjs:642-655`).
- Git network subcommands are identified and rejected by the shared runner while offline (`packages/core/src/util/index.mjs:70-79`).
