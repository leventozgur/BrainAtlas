# Local panel (`brainatlas ui`)

`brainatlas ui [--no-open] [--json]` starts a small local web panel and prints its URL. Stop it with Ctrl+C.

- It listens on `127.0.0.1` only, on a random port, and every request needs a per-run token (the URL carries it once; the page removes it from the address bar). Requests with a foreign `Host` or `Origin` are refused.
- The panel shows the status summary (same data as `status --summary`), agent channels and the editable scalar settings.
- Changes are never applied directly: `Plan` shows what would change, `Apply` is a separate step. Both run the same code as `agent set` and `config set`, so the result is identical to the CLI.
- Paths, interpreter, state location, sync transport options, channels, agents and modules cannot be edited from the panel. In a read-only installation all changes are disabled (HTTP 403).
- Output is redacted, and the vault path and token are never shown in the page data.
