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

Output is at most 4002 characters (Codex at most 1400). The deadline is 4700 ms; timeout fails open with empty output and exit code 0. Metrics contain only client, event, duration, character count, result count, mode, and a hashed session ID.

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
