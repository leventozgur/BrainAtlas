---
contract-version: 1
---
# Safety (secret filter) contract

## Purpose
One shared API that every writer and emitter (hook output, MCP writes, checkpoint, sync) uses before data leaves its boundary.
The filter cannot be disabled (`safety.secretFilter` is locked to `true`); Full may only add `extraDenyGlobs`.

## Function signatures
```js
/** @returns {Finding[]} */ export function scanText(text, { rules } = {});
/** @returns {Finding[]} */ export function scanPath(relPath, { denyGlobs, extraDenyGlobs } = {});
/** @returns {string}    */ export function redact(text, { rules } = {});
// Finding = { ruleId: string, kind: 'content' | 'path', start: number, end: number }
```

## Input
- `scanText`: any string; optional extra `rules` (`{id, pattern: RegExp}`).
- `scanPath`: vault-relative path; `\` and `./` are normalised; matching is case-insensitive. Default deny globs live in `packages/core/src/safety/rules.mjs`.

## Output
- An empty array means clean / allowed. Findings carry **no matched value**, only rule id, kind and offsets.
- `redact` replaces each (merged) match with `[REDACTED:<ruleId>]`.

## Errors
- `TypeError` for non-string input or an invalid custom rule. Callers translate a non-empty finding list into their own refusal code
  (`E_SECRET_DETECTED` for MCP/checkpoint/sync writes; hooks redact instead of refusing).

## Example
```js
if (scanText(body).length || scanPath(rel).length) throw new BrainAtlasError('E_SECRET_DETECTED', 'write refused: secret-like content');
```

## Security
Never log, return or persist the matched value. Performance: 1 MB < 200 ms; linear-time patterns (adversarial 100 KB inputs tested).
Measured (C3 blind test, unseen synthetic set): 72/72 positives detected, 0/97 false positives.
