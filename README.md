# BrainAtlas

**Evidence-first memory for coding agents.** BrainAtlas keeps project knowledge in a local Markdown Wiki, retrieves relevant evidence through MCP and supported hooks, and lets agents work from cited context.

English | [Türkçe](README.tr.md)

## What it is

- A local knowledge vault with pages, an index, a log, and optional metadata checks.
- An MCP server with bounded read and retrieval tools, status and lint, and controlled writes when read-only mode is off.
- Agent adapters that preview and manage only their owned configuration, with trust review steps.

BrainAtlas is designed for coding agents, but the vault does not restrict content type: non-project notes work too.

BrainAtlas is not a hosted knowledge service, a general-purpose agent, or a guarantee that an agent follows retrieved evidence. It does not send telemetry. The secret filter is on by default and locked in the Lite and Full profiles; only the custom profile can opt out of its write refusals. Core configuration sets telemetry to false. See [Security](SECURITY.md).

## Requirements

- macOS or Linux for the release installer.
- Node.js 20 or newer.
- `ssh-keygen` for release signature verification.

Semantic retrieval additionally needs a local Ollama installation.

## Install (Quickstart)

### Online

Releases are published on GitHub Releases: https://github.com/leventozgur/BrainAtlas/releases. Download `brainatlas-0.1.0-distribution.tar.gz` from a release, extract it into an empty folder, and run the installer from that folder. The distribution contains `brainatlas-0.1.0-lite.tgz`, `brainatlas-0.1.0-full.tgz`, `install.sh`, `release/`, `SHA256SUMS`, and `SHA256SUMS.sig`. The maintainer signing key fingerprint is `SHA256:PPcml0QiRHQJrtPnqWMXF77PgJhPT27GOHboOMJCw40`; compare it with `release/allowed_signers` before installing.

```sh
sh install.sh --from brainatlas-0.1.0-lite.tgz --allowed-signers release/allowed_signers --yes
brainatlas init --profile lite --agents claude-code,copilot-vscode,kiro
brainatlas doctor
```

Replace `brainatlas-0.1.0-lite.tgz` with `brainatlas-0.1.0-full.tgz` to install the Full profile. Review any agent trust prompts and verify integration in each agent. See [Installation](docs/user/install.md) for signature and verification details.

### Offline

Obtain the complete distribution folder from a trusted source. It contains `brainatlas-0.1.0-lite.tgz`, `brainatlas-0.1.0-full.tgz`, `install.sh`, `release/`, and the signed `SHA256SUMS` and `SHA256SUMS.sig`. Extract `brainatlas-0.1.0-distribution.tar.gz` into an empty folder if you received the archive, then run the same installer command from that folder:

```sh
sh install.sh --from brainatlas-0.1.0-lite.tgz --allowed-signers release/allowed_signers --yes
brainatlas init --profile lite --agents claude-code,copilot-vscode,kiro
brainatlas doctor
```

## Verify

`install.sh` verifies `SHA256SUMS.sig` automatically with `ssh-keygen -Y verify` against `release/allowed_signers`, using the identity and namespace `brainatlas-release`, and then checks the SHA-256 of every file before extracting it. `--insecure-skip-signature` skips the signature check and should be used only when you explicitly accept that risk.

To verify a distribution by hand, run these commands in the extracted folder:

```sh
ssh-keygen -Y verify -f release/allowed_signers -I brainatlas-release -n brainatlas-release -s SHA256SUMS.sig < SHA256SUMS
shasum -a 256 -c SHA256SUMS
```

The maintainer signing key fingerprint is `SHA256:PPcml0QiRHQJrtPnqWMXF77PgJhPT27GOHboOMJCw40`; compare it with `release/allowed_signers`.

## Supported agents

| Agent | Integration mode in this repository | Trust review |
|---|---|---|
| Claude Code | MCP, prompt and session-start hooks, managed `CLAUDE.md` pointer | Review the planned MCP, hook, and instruction edits. |
| GitHub Copilot in VS Code | MCP, session-start hook, managed instructions | Per-prompt hooks are unsupported by Copilot; context uses session-start plus pull-mode MCP. Global instructions path is unverified. |
| Kiro | MCP, steering file, prompt hook | Prompt trigger name and compatibility are unverified; review before relying on it. |
| Codex CLI | MCP and managed instruction pointer; hook support is adapter-dependent | Review the resulting MCP and instruction configuration. |
| Gemini CLI | MCP, managed instruction pointer, `BeforeAgent` and `SessionStart` hooks | Enable the hook entries in Gemini's `/hooks` panel if required. |

Adapters can create or modify agent configuration. Inspect the plan and trust review, then confirm the agent loads the MCP server and instructions. See [Agent setup](docs/user/agents.md).

## Profiles

| Profile | Contents | Notes |
|---|---|---|
| Lite | Core only; no optional modules | Secret filtering enabled; telemetry off. Recommended starting profile. |
| Full | Core plus modules marked for Full in the selected release | Optional modules include sync, semantic retrieval, receipts, and strict OKF-inspired checks. Availability depends on release contents. |

Semantic retrieval is opt-in, uses local Ollama, and is off by default; on the independent semantic holdout v2 (`wiki_query`, EmbeddingGemma), TR→EN rose from 0/10 to 8/10 and EN→TR from 2/10 to 8/10, while difficult near-topic negatives were not improved (2/10 abstained before and after). Review module status before enabling optional functionality.

Experimental in 0.1.0: semantic retrieval, Git/folder/Dropbox sync, the local panel (`brainatlas ui`), and the `maintain-schedule` module. These features may change between releases. See [Retrieval](docs/user/retrieval.md) and [Semantic retrieval](docs/user/semantic.md) for details.

## Commands

| Command | Purpose | Writes? |
|---|---|---|
| `brainatlas wiki query\|read\|index\|list\|status\|lint` | Read-only Wiki tools from the shell; same results as the MCP read tools | no |
| `brainatlas status [--summary]` | Show installation status; `--summary` prints the short form | no |
| `brainatlas doctor` | Check installation health | no |
| `brainatlas maintain [--repo DIR]` | Report stale, broken, orphan and oversized pages | no (unless `--queue`) |
| `brainatlas maintain --fix (--plan\|--apply)` | Repair index lines, archived links and source lists; `--sources` includes source checks | `--apply` only |
| `brainatlas maintain --weekly` | Write a read-only maintenance snapshot | snapshot only |
| `brainatlas maintain --proposals list\|show <id>\|accept <id>\|reject <id>` | Review stored current-state proposals | `accept` only |
| `brainatlas compact --page wiki/<page>.md --plan\|--apply` | Move older dated sections of a long page into `wiki/archive/` without losing lines | `--apply` only |
| `brainatlas usage [--days N]` | Summarize content-free hook metrics | no |
| `brainatlas ui [--no-open] [--json]` | Experimental local panel for status, agent channels and settings (127.0.0.1 only) | panel apply only |
| `brainatlas update --from <archive>` | Install an update from a verified release archive | installation only |
| `brainatlas update --check --from <archive>` | Inspect a release archive without installing it | no |
| `brainatlas rollback [--to VERSION]` | Switch to the prior release, or to an installed version | installation only |
| `brainatlas module list\|add\|remove` | List, add, or remove installed modules | `add` and `remove` only |
| `brainatlas safety allow\|list\|revoke` | Review and manage fingerprinted safety allowances | `allow` and `revoke` only |
| `brainatlas adopt --plan` | Inspect existing agent setup and propose adoption | no |
| `brainatlas eval [--cases FILE] [--corpus DIR]` | Run the local retrieval evaluation | no |
| `brainatlas maintain-schedule install\|status\|remove` | Full or custom profile, experimental: install, inspect or remove the weekly maintenance timer | `install` and `remove` only |

Guides: [Wiki CLI](docs/user/wiki-cli.md), [Maintenance report](docs/user/maintain.md), [Compact](docs/user/compact.md), [Usage](docs/user/usage.md).

## Configuration and features

Settings live in the BrainAtlas configuration file (`~/Library/Application Support/BrainAtlas/config.json` on macOS; other paths are in the [config contract](docs/contracts/config.md)). Read and change them with `brainatlas config get [KEY]`, `brainatlas config set KEY VALUE [--plan]` and `brainatlas config unset KEY [--plan]`; `--plan` previews the change without writing it.

| Feature | Default | Turn on / off | Details |
|---|---|---|---|
| Prompt hook injection | on (`hooks.mode normal`) | `brainatlas config set hooks.mode economic` injects only for question-like prompts or `/sb`, `@sb`; `manual` injects only for `/sb` or `@sb` and also turns off the session-start recap; `normal` restores it | [Agent setup](docs/user/agents.md) |
| Progressive disclosure | off (`hooks.disclosure` absent = `full`) | `brainatlas config set hooks.disclosure progressive`; `brainatlas config unset hooks.disclosure` restores `full` | [Retrieval](docs/user/retrieval.md) |
| Semantic retrieval (Full, experimental) | off | `brainatlas config set semantic.enabled true` / `false`; needs local Ollama | [Semantic retrieval](docs/user/semantic.md) |
| Search scope | `wiki/` when present; root navigation pages excluded | `brainatlas config set retrieval.exclude '["drafts/**"]'`; `[]` excludes nothing; `brainatlas config unset retrieval.exclude` restores the default | [Retrieval](docs/user/retrieval.md) |
| MCP write tools | on | `brainatlas config set readOnly true` leaves only the read tools; `false` restores writes | [Contracts](docs/contracts/) |
| Shell instead of MCP and hooks | off (default channel is MCP) | `brainatlas init --channel cli` or per agent `--channel claude-code=cli,kiro=mcp`; to change the channel of an installed agent later use `brainatlas agent set <agent> --channel mcp\|cli` | [CLI channel](docs/user/cli-channel.md) |
| Add, remove or switch one agent | per `init --agents` | `brainatlas agent list` (shows detected agents); `brainatlas agent add <agent> [--channel mcp\|cli] [--plan]`; `brainatlas agent remove <agent> [--plan]` | [Agent setup](docs/user/agents.md) |
| Folder, Git or Dropbox sync (Full, experimental) | off | Configured with `sync.transport`; see the guide before enabling | [Sync](docs/user/sync.md) |
| Telemetry and secret filter | telemetry off and locked; secret filter on by default | Telemetry cannot be changed (`E_LOCKED_KEY`). The secret filter is locked on in Lite and Full; only the custom profile may set `safety.secretFilter false`, which lifts only write refusals while output redaction, path deny rules and sync scans stay on | [Security](SECURITY.md) |

To stop BrainAtlas completely, run `brainatlas uninstall` (the vault is kept).

## Privacy and security

Vault and state are local. BrainAtlas has no telemetry, and core configuration sets telemetry to false. The secret filter scans content before supported writes; it is locked on in Lite and Full. In the custom profile `brainatlas config set safety.secretFilter false` stops refusing writes with secret-like content, while output redaction, path deny rules and sync scans stay on. Default path-deny rules also block sensitive locations and files. Hooks return bounded context and their metrics omit prompt text, page content, paths, and raw session identifiers. Optional sync transports move vault data only when configured; understand the selected transport and credentials before enabling it.

See [Security](SECURITY.md), [Sync](docs/user/sync.md), and the [contracts](docs/contracts/).

## Update, rollback, and uninstall

Install an update from a verified release archive with `brainatlas update --from <archive>`. The CLI checks release health and restores the prior release if the new one fails its health check. Use `brainatlas rollback` to return to the prior release, or `brainatlas rollback --to VERSION` for a specific installed version. Run `brainatlas uninstall` to remove BrainAtlas-managed installation and adapter changes; the configured vault is preserved. Review `--plan` output where supported before applying changes.

## Comparison and related work

BrainAtlas does not publish feature comparisons with other tools because their features change and were not independently verified.

- The LLM Wiki pattern popularised by Andrej Karpathy: the idea of an LLM-maintained Wiki or note collection, with no code from that work used here.
- Microsoft llmwiki core (vendored in this repository, MIT; see [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES)).
- avenoxbeyin (https://github.com/avenoxai/avenoxbeyin): design patterns only (BM25 `k1=1.5` and `b=0.75`, vault-id hash pattern, release and installation patterns), MIT, no code copied; see [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES).

## User guides

- [Install and verify releases](docs/user/install.md)
- [Agent integrations and trust review](docs/user/agents.md)
- [Retrieval behavior and measured quality](docs/user/retrieval.md)
- [OKF-inspired metadata](docs/user/okf.md)
- [Sync behavior](docs/user/sync.md)
- [Maintenance report](docs/user/maintain.md)
- [Read-only Wiki CLI (`brainatlas wiki`)](docs/user/wiki-cli.md)
- [CLI channel (instructions instead of MCP and hooks)](docs/user/cli-channel.md)
- [Compact long pages](docs/user/compact.md)
- [Usage summary and feedback](docs/user/usage.md)
- [Local panel (`brainatlas ui`, experimental)](docs/user/ui.md)
- [Semantic retrieval (experimental)](docs/user/semantic.md)
- [Troubleshooting](docs/user/troubleshooting.md)

## Changelog and contributing

- [Changelog](CHANGELOG.md)
- [Contributing](CONTRIBUTING.md)

## License

MIT. See [LICENSE](LICENSE).
