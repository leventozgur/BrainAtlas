# Changelog

## Unreleased

## 0.1.0-rc.10 — 2026-11-09

Reliability of semantic indexing on slow machines. Indexing is not faster: on a 2012 CPU it stays about 1.2 seconds per chunk (about 16 minutes for 819 chunks). What changes is that it completes with default settings, keeps its progress, and tells you how long it will take. Fast machines behave as before (the index written is byte-identical for the same provider).

- Indexing has its own settings: `semantic.indexTimeoutMs` (per request, default 120000) and `semantic.indexBatchSize` (texts per request, 1–64, default 32). The query timeout `semantic.timeoutMs` (default 5000) is unchanged. Before this, a slow host failed `semanticSetup` at the first batch because the query timeout also applied to indexing.
- Adaptive batches: a batch slower than 20 seconds halves the next batch, a batch faster than 5 seconds doubles it (up to `indexBatchSize`).
- Resumable indexing: progress is saved to `index.partial.json` in the state directory at least every 30 seconds and on error or cancel; running the command again embeds only the missing chunks, and the final index is identical to a single clean run. `brainatlas semanticStatus` reports `partialChunks`. A process killed with SIGKILL can lose up to 30 seconds of progress. Queries never read the partial file.
- Progress and estimate: `semanticSetup` shows one updating progress line with an estimated remaining time instead of one line per file. If the estimate exceeds 5 minutes it says so and, in an interactive terminal without `--yes`, asks once before continuing (declining keeps the saved progress). `--dry-run` reports how many chunks are still to embed.
- A lock file prevents two indexing runs at the same time (`E_SEMANTIC_BUSY`); `semanticSetup` reports "Another indexing operation is running."
- The MCP server's background index refresh now uses the indexing settings (it previously used the query timeout) and is cancelled when the server closes (it waits at most 2 seconds).
- Not re-measured on the 8 GB reference host after these changes; verified with a real Ollama behind a delayed proxy (default settings, kill and resume).

## 0.1.0-rc.9 — 2026-11-09

- New guided command `brainatlas semanticSetup` for the optional semantic retrieval. It checks that Ollama is installed and running, offers the ~240 MB embedding model download, builds the local index, verifies it with a probe query, and enables `semantic.enabled` only after everything succeeded. It never installs Ollama (it prints the official install command instead), never uses `sudo` or `curl | sh`, and only talks to the configured loopback address. `--dry-run` changes nothing; without a terminal and without `--yes` it behaves like `--dry-run`; `--mode semantic-primary|rrf` selects the retrieval mode. Exit code 0 when ready, 2 when an action is still needed.
- `brainatlas doctor` no longer warns "Semantic index is not available." while semantic retrieval is off; the `semantic` health entry now includes `enabled`.
- Install guide: GitHub Release assets cannot carry the `release/` subdirectory, so the guide now points to the `brainatlas-<version>-distribution.tar.gz` asset; troubleshooting covers missing Ollama, a stopped server, a missing model and a stale index.

## 0.1.0-rc.8 — 2026-11-09

- MCP now reads `BRAINATLAS_PLATFORM` like the CLI, fixing Linux CI platform detection.
- `wiki_query` scores are compressed with a square root. At the default abstain threshold of 0.35, natural-language development-set recall@5 rose from 0.337 to 0.747. For custom `retrieval.abstainThreshold` values, use the square root of the old value for equivalent strictness (for example, 0.5 → ≈0.71; 0.25 → 0.5).
- Retrieval results now include `heading`, `anchor`, and `headingPath`; snippets show the matching section, including its heading line.
- Search caches are never written to the vault, and sync excludes cache paths.
- Semantic retrieval is opt-in through `semantic.enabled`, uses local Ollama, is off by default, and falls back to BM25. `semantic.mode` is `semantic-primary` (default, tuned for cross-language retrieval) or `rrf` (hybrid; measured better on a mixed-language vault).
- Added repository evaluation tools: `npm run eval`, `eval/semantic-eval.mjs`, and `eval/semantic-calibrate.mjs`, with a natural corpus and development sets. Evaluation data is not included in releases.

## 0.1.0-rc.7 — 2026-11-08 (first public pre-release)

- Signed with the maintainer release key (fingerprint `SHA256:PPcml0QiRHQJrtPnqWMXF77PgJhPT27GOHboOMJCw40`); earlier candidates used a development key.
- Secret filter: Markdown page titles containing "secret" are no longer refused on their own; `brainatlas safety allow|list|revoke` records fingerprinted exceptions for reviewed false positives (new or changed matches are still refused).
- Releases are published on GitHub Releases.
- Agent MCP/hook launch: `bin/brainatlas` runs under both sh and node (MCP connections were closing on start).
- Claude Code and Gemini hooks use the CLI hook contract (`hook <client> <event>`); legacy entries are upgraded on install.

## 0.1.0-rc.6 — 2026-11-08

- `brainatlas sync schedule install|remove|status` installs a LaunchAgent (macOS, label `org.brainatlas.sync`) or a systemd user timer (Linux); safe temp files, HOME containment, failed stops keep files and can be retried; `uninstall` removes the schedule.
- A never-synced host's untouched init-template files yield to remote content on first sync (no seed conflicts).
- Tests no longer inherit `BRAINATLAS_OFFLINE` from the environment.

## 0.1.0-rc.5 — 2026-11-08

- Codex adapter parses real-world `config.toml` (quoted table headers, inline tables, multi-line arrays and strings, array tables); markers inside strings are ignored; an agent config directory that resolves outside HOME is refused unless `BRAINATLAS_ALLOW_SYMLINKED_ROOT=1`.

## 0.1.0-rc.4 — 2026-11-08

- `init` preserves an existing configuration (vault path from `install.sh --vault`, sync settings, host id); only flags given explicitly change it.

## 0.1.0-rc.3 — 2026-11-08 (built and verified locally, not tagged: `init` reset an existing configuration)

- `init` now creates the vault skeleton (idempotent, never overwrites); `migrate` accepts a destination that only holds an untouched init skeleton.
- `--json` commands print exactly one JSON value on stdout; errors use `{"ok":false,"error":{…}}`; module logs go to stderr.
- Removed build artifacts accidentally committed under `release/dist/`.

## 0.1.0-rc.2 — 2026-11-08 (built and verified locally, not tagged: second-host sync failed because `init` did not create the vault)

- Added a self-contained release distribution folder and install kit (R-KIT).
- Added Git transport setup and sync operations (S-OPS), plus stable host identity configuration (S-HOSTID).
- Added Gemini CLI `BeforeAgent` and `SessionStart` hooks (A-GEMINI2).
- Hardened output redaction and health reporting (I-HARDEN).
- Added the MIT attribution for avenoxbeyin in `THIRD_PARTY_NOTICES`.

## 0.1.0-rc.1 — 2026-11-08 (local release candidate; signed with a development key, not published)

- Added Lite and Full release profiles with signed archive verification and install/update/rollback support.
- Added local configuration, vault paths, doctor/status checks, and managed uninstall behavior.
- Added coding-agent adapters for Claude Code, GitHub Copilot in VS Code, Kiro, Codex CLI, and Gemini CLI.
- Added MCP tools for Wiki retrieval, reading, status, lint, and controlled writes.
- Added bounded hooks, local secret filtering, path deny rules, and privacy-preserving hook metrics.
- Added OKF v0.2-inspired local metadata checks and optional strict module.
- Added optional Git and Dropbox synchronization modules; folder sync is experimental.
- Added optional semantic retrieval behind an evaluation gate; experimental and off by default.
- Added `migrate` (copy-based, source read-only), `adopt --plan` and `help`.
- Added session-end receipts with a human review queue (Full).
