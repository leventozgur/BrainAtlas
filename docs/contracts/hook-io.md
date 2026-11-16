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

### Progressive disclosure (BA-32)

`hooks.disclosure` is optional and is `full` (the default when absent) or `progressive`; any other value is a configuration error, and no default is written into a new configuration. With `full` or no value the output, exit code, metrics and state file are byte-identical to before.

With `progressive`, only the packing of fresh results changes. The first two results stay full blocks: the first excerpt is never clipped by progressive packing (it reaches the block packer unchanged and is only cut to the cap exactly as in `full`), while a second snippet longer than 300 UTF-16 units is first replaced by 299 units (`prefixKeepingPairs`) plus `…` (a snippet of at most 300 units stays whole), and when the result carries an `anchor` the title line ends `(path#anchor)` so an agent can read the rest of a cut section. If a full block does not fit, packing stops with no pointers. The next up to six results become pointers after an empty line and the exact header line `More matches (open with wiki_read_page path + anchor):`, one line each: `- Title › Heading [unverified] (path#anchor)`. ` › Heading`, ` [unverified]` (weak trust) and `#anchor` appear only when they exist, and each line is redacted like a block title. A pointer is added only while the envelope fits the cap; the header is added together with the first pointer, so it never appears alone, and the first pointer that does not fit stops pointer packing. Only full-block paths enter the session `seen` state (a former pointer page may be injected in full by a later prompt); metrics `results` counts full blocks plus pointers.

### Search scope (BA-29)

The prompt hook searches the scope from `searchScope(config.vault.path, config.retrieval.exclude)`: the `wiki/` folder when it exists, otherwise the vault root, with the default exclusions. Result paths stay vault-relative: a wiki page is reported as `wiki/<path>` in the block header, so `seen` state and the output format are unchanged. Restriction checks read the page at the vault-relative path. Only the set of searchable pages changes; session-start recap is not affected.

### Semantic step (BA-07)

When `semantic.enabled` is true, the profile is not `lite`, and the modules include `*` or `semantic`, the retrieval worker runs one more step after the lexical search. The step loads the installed semantic module by dynamic import (never statically, and never in Lite or when the option is off), reads the index from the global state directory (`<state>/semantic/index.json`, read-only) and embeds the prompt through the configured loopback provider. It returns the hybrid list (`searchHybrid`, same fusion and mode as the MCP path). The hook packing, the per-session dedup and the redaction apply to that list unchanged. BA-26: a result whose `inject` is `never`, and (after the semantic step ran) any page whose head marks it `sensitivity: personal` or `inject: never`, is removed before packing and is never recorded as seen (see retrieval contract, Restricted pages). The hook output is redacted with `redact(text, { personal: true })`: secrets, TCKN and TR IBAN, e-mail addresses and TR phone numbers.

The step has its own budget, `SEMANTIC_BUDGET_MS` = 350 ms, measured from the end of the lexical search and inside the hook deadline, which is never exceeded. Any failure returns the lexical list computed for the same prompt, so the output is the BM25 output exactly. Fallback reasons: `index-missing`, `fingerprint-mismatch`, `remote-not-allowed`, `provider-error`, `module-missing`, `module-load-error`, `deadline`. Abstention of the hybrid search also keeps the lexical list. The semantic index is built over the Wiki folder (`wiki/`), while the hook's lexical corpus is the vault root, so a semantic entry `p` is matched to the page `wiki/p` when that page is in the lexical index.

Hybrid results carry the provenance trust (`verified` or `weak`) of their page, so the `[unverified]` marker of BA-09 also applies to semantic-only hits.

The metric record gains one optional field, `semantic`, only when the step was requested: `used` or `fallback:<reason>`. It is absent when the step was not requested, so semantic-off and Lite records keep their previous key set. It never carries prompt text, page paths or the query.

The metric record also gains one optional field, `shadow`, only when `retrieval.shadow` is configured: `{top1Same, overlap5, injectDiff}` compares the baseline lexical top five with a second lexical search at the shadow `abstainThreshold`, and it never carries prompt text, page paths or the query.

The permission command (`buildHookCommand`) grants read access to `<state>/semantic` only. No write grant is added, and network access is not restricted by the Node permission model (the provider URL is limited to loopback by configuration).

Session-start (`claude`, `copilot`, and `gemini` when `source` is `startup`, `resume` or `clear`) returns a session recap, using the same envelope as the prompt output. A non-empty `stateDir/handoff.md` is returned unchanged and takes precedence. Otherwise, unless `hooks.mode` is `manual`, `buildRecap` (`packages/hooks/src/recap.mjs`) builds a card of at most 800 characters from the newest 64 KB of `wiki/log.md`. It lists up to 5 distinct pages changed in the last 14 days, read from machine lines `- <ISO-ts> {"action":…,"path":"wiki/…md"}`. Each page gets a title from its first 4 KB, and the card also reports the pending receipt count from `stateDir/receipts/queue/*.json` when that directory exists. BA-26: page lines of restricted pages are removed (the same check as above). The card format is fixed and English, its text is passed through `redact()` with the personal option, and it is empty when there is nothing to report. Symlinked logs, queue directories and pages are never followed, and nothing outside the vault is read. Any recap failure yields empty output. Metrics for session-start are unchanged; the recap adds no metric fields.

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
