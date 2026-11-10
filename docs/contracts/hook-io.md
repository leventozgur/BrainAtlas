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

Output is at most 4002 characters (Codex at most 1400). The deadline is 4700 ms; timeout fails open with empty output and exit code 0. Metrics (JSONL `stateDir/metrics/hooks.jsonl`, mode 0600) contain only `ts`, `client`, `event`, `mode`, `durationMs`, `chars`, `results`, `outcome` (`ok|empty|deadline|error`) and `session` (first 16 hex of sha256(session_id)) — never prompt text, page paths or the raw session id.

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
