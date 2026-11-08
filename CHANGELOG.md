# Changelog

## Unreleased

- MCP now reads `BRAINATLAS_PLATFORM` like the CLI, fixing Linux CI platform detection.
- `wiki_query` scores are compressed with a square root. At the default abstain threshold of 0.35, natural-language development-set recall@5 rose from 0.337 to 0.747. For custom `retrieval.abstainThreshold` values, use the square root of the old value for equivalent strictness (for example, 0.5 → ≈0.71; 0.25 → 0.5).
- Retrieval results now include `heading`, `anchor`, and `headingPath`; snippets show the matching section, including its heading line.
- Search caches are never written to the vault, and sync excludes cache paths.
- Semantic retrieval is opt-in through `semantic.enabled`, uses local Ollama, is off by default, and falls back to BM25.
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
