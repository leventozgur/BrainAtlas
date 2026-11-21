# Troubleshooting

Start with:

```sh
brainatlas doctor
brainatlas status
brainatlas status --summary
```

`status --summary` (add `--json` for scripts) prints one read-only table: version, profile, modules, per-agent channels, hook mode, semantic state, last sync, OKF counts and `maintain` findings. `wiki lint`, `okf check` and `maintain` apply different rules, so a clean `wiki lint` does not mean the other two are clean; the summary lists them side by side. The OKF line uses the core rules; `okf check` also applies the strict module rules when installed.

`doctor` reports whether the current release and configured adapter checks pass. It does not prove that every agent version loads its configuration or permits hooks.

| Symptom | Check |
|---|---|
| `brainatlas` command not found | Confirm the install's `~/.local/bin` is on `PATH`; run the installed shim by its full path if needed. |
| Node version error | Use Node.js 20 or newer. |
| Signature verification fails | Confirm archive, checksum/signature files, and allowed-signers file are from the same trusted release. Do not bypass verification unless accepting that risk. |
| Agent does not see BrainAtlas | Review adapter files, restart/reload the agent, verify workspace trust and MCP startup, then run `brainatlas doctor`. |
| Copilot context is missing | Copilot adapter uses session-start and pull-mode MCP, not per-prompt hooks. Verify the MCP server and organization policy. Global instruction location remains unverified. |
| Kiro hook does not run | The configured prompt trigger name is unverified. Use MCP pull-mode tools and verify compatibility with the installed Kiro version. |
| Update health check fails | Installer/update should retain or restore the prior release; run `brainatlas doctor`, then `brainatlas rollback` if needed. |
| Sync reports conflicts or pending deletes | Inspect conflict copies and pending-delete status; explicitly review and approve deletions before they propagate. |
| A write is refused by the safety filter | Review the page for secret-like content and sensitive paths. To accept a known false positive, use `brainatlas safety allow <path>`. In the custom profile you can also turn off content refusals with `brainatlas config set safety.secretFilter false` (path deny rules still apply). Error output does not reveal matched values. |

| Ollama is missing | Install it using the official download, then run `brainatlas semanticSetup`. |
| Ollama server is stopped | Start it with `ollama serve`, then run `brainatlas semanticSetup`. |
| Semantic model is missing | Run `brainatlas semanticSetup` and approve the download. |
| Semantic index is stale | Run `brainatlas semanticIndex` and check `brainatlas semanticStatus`. |


## Slow or interrupted semantic indexing

- **Indexing takes a long time:** Run `brainatlas semanticSetup --dry-run` to see the pending chunk count. Run setup while the machine is idle; duration depends on the hardware. Increase `semantic.indexTimeoutMs` if individual requests time out.
- **Indexing stopped partway through:** Run `brainatlas semanticSetup --yes` again to resume saved chunks. Check `partialChunks` with `brainatlas semanticStatus`.
- **Another indexing operation is running:** Wait for it to finish before running `brainatlas semanticIndex` again. An abandoned lock is recovered automatically.
