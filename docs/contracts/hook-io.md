---
contract-version: 1
---
# Hook I/O contract

## Purpose

Accept agent hook events and return bounded, privacy-preserving context.

## Function signatures

```js
/** @param {{client:'claude'|'codex'|'kiro'|'copilot'|'gemini',event:'prompt'|'session-start'|'session-end',stdin:string,env:object,now:Date,config:Config}} input @returns {Promise<{stdout:string,exitCode:number}>} */
export function runHook(input);
```

## Input

`stdin` is the client event payload. `config.hooks.mode` is `normal`, `economic`, or `manual`. `/sb` and `@sb` are explicit retrieval triggers. Claude prompt output envelope is `{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"…"}}`.

## Output and errors

Output is at most 4002 characters (Codex at most 1400). The deadline is 4700 ms; timeout fails open with empty output and exit code 0.

Prompt blocks are packed one result at a time. The hook sends retrieval no cumulative snippet budget and each excerpt is at most 4002 characters (the worker redacts, then caps it). A block is `Title (path)` followed by its excerpt. The header line must fit whole; if it does not, that block and every later one are dropped. An excerpt that does not fit is cut and ends with `…`, and at least one character of excerpt must fit, so a block with page text is never injected header-only. A page is recorded in the session's `seen` state only when its header line was injected. The effective cap is the same as before: 4002 normal, 1500 economic, 1400 Codex, or `retrieval.budgetChars` when that is smaller. Metrics (JSONL `stateDir/metrics/hooks.jsonl`, mode 0600) contain only `ts`, `client`, `event`, `mode`, `durationMs`, `chars`, `results`, `outcome` (`ok|empty|deadline|error`), `session` (first 16 hex of sha256(session_id)) — never prompt text, page paths or the raw session id.

### Semantic step (BA-07)

When `semantic.enabled` is true, the profile is not `lite`, and the modules include `*` or `semantic`, the retrieval worker runs one more step after the lexical search. The step loads the installed semantic module by dynamic import (never statically, and never in Lite or when the option is off), reads the index from the global state directory (`<state>/semantic/index.json`, read-only) and embeds the prompt through the configured loopback provider. It returns the hybrid list (`searchHybrid`, same fusion and mode as the MCP path). The hook packing, the per-session dedup and the redaction apply to that list unchanged.

The step has its own budget, `SEMANTIC_BUDGET_MS` = 350 ms, measured from the end of the lexical search and inside the hook deadline, which is never exceeded. Any failure returns the lexical list computed for the same prompt, so the output is the BM25 output exactly. Fallback reasons: `index-missing`, `fingerprint-mismatch`, `remote-not-allowed`, `provider-error`, `module-missing`, `module-load-error`, `deadline`. Abstention of the hybrid search also keeps the lexical list. The semantic index is built over the Wiki folder (`wiki/`), while the hook's lexical corpus is the vault root, so a semantic entry `p` is matched to the page `wiki/p` when that page is in the lexical index.

Hybrid results carry the provenance trust (`verified` or `weak`) of their page, so the `[unverified]` marker of BA-09 also applies to semantic-only hits.

The metric record gains one optional field, `semantic`, only when the step was requested: `used` or `fallback:<reason>`. It is absent when the step was not requested, so semantic-off and Lite records keep their previous key set. It never carries prompt text, page paths or the query.

The permission command (`buildHookCommand`) grants read access to `<state>/semantic` only. No write grant is added, and network access is not restricted by the Node permission model (the provider URL is limited to loopback by configuration).

Session-start (`claude`, `copilot`, and `gemini` when `source` is `startup`, `resume` or `clear`) returns a session recap, using the same envelope as the prompt output. A non-empty `stateDir/handoff.md` is returned unchanged and takes precedence. Otherwise, unless `hooks.mode` is `manual`, `buildRecap` (`packages/hooks/src/recap.mjs`) builds a card of at most 800 characters from the newest 64 KB of `wiki/log.md`. It lists up to 5 distinct pages changed in the last 14 days, read from machine lines `- <ISO-ts> {"action":…,"path":"wiki/…md"}`. Each page gets a title from its first 4 KB, and the card also reports the pending receipt count from `stateDir/receipts/queue/*.json` when that directory exists. The card format is fixed and English, its text is passed through `redact()`, and it is empty when there is nothing to report. Symlinked logs, queue directories and pages are never followed, and nothing outside the vault is read. Any recap failure yields empty output. Metrics for session-start are unchanged; the recap adds no metric fields.

### Errors

- `E_HOOK_INPUT`: malformed stdin; fail open with empty output and exit code 0.
- `E_HOOK_DEADLINE`: processing exceeded the deadline; fail open with empty output and exit code 0.
- `E_HOOK_CLIENT`: unknown client; return empty output and exit code 2.

## Example

```js
const result = await runHook({client:'claude',event:'prompt',stdin:'{}',env:{},now:new Date(),config});
// result is { stdout, exitCode: 0 } on fail-open.
```

## Security

Never retain prompt text, page content, or raw session identifiers in logs or metrics. Bound runtime and output size.

## Version

Signature is fixed in `packages/hooks/src/index.mjs`. Contract version 1.
