# Local panel (`brainatlas ui`)

> **Experimental.** The local panel is an experimental convenience and may change between releases.

`brainatlas ui [--no-open] [--json]` starts a small local web panel and prints its URL. Stop it with Ctrl+C, or let it close itself after 30 minutes without a request; it then prints `BrainAtlas panel closed after 30 minutes idle.` and exits with status 0.

- It listens on `127.0.0.1` only, on a random port. The printed URL carries the per-run token in the fragment (`/#t=<token>`), which the browser never sends to the server; the page reads it from `location.hash`, removes it from the address bar and sends it as the `x-brainatlas-token` header on every API call. Requests with a foreign `Host` or `Origin` are refused.
- On a shared machine, use `--no-open`: the opened URL is visible to other local users in the process list.
- The panel shows the status summary (same data as `status --summary`), agent channels and the editable scalar settings.
- Changes are never applied directly: `Plan` shows what would change, `Apply` is a separate step. Both run the same code as `agent set` and `config set`, so the result is identical to the CLI.
- Paths, interpreter, state location, sync transport options, channels, agents and modules cannot be edited from the panel. In a read-only installation all changes are disabled (HTTP 403).
- Output is redacted, and the vault path and token are never shown in the page data.
