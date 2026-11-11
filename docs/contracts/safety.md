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
/** @returns {string}    */ export function redact(text, { rules, personal } = {});
// Finding = { ruleId: string, kind: 'content' | 'personal' | 'path', start: number, end: number }
// 'contact' spans exist only inside redact(text, { personal: true }); scanText never reports them.
```

## Input
- `scanText`: any string; optional extra `rules` (`{id, pattern: RegExp}`).
- `scanPath`: vault-relative path; `\` and `./` are normalised; matching is case-insensitive. Default deny globs live in `packages/core/src/safety/rules.mjs`.

## Output
- An empty array means clean / allowed. Findings carry **no matched value**, only rule id, kind and offsets.
- `redact` replaces each (merged) match with `[REDACTED:<ruleId>]`.
- `kind: 'personal'` (BA-26): `tckn` and `tr-iban` findings. They are reported by `scanText`, so writes are refused, and `redact` replaces them
  like secrets. Only a candidate that passes its checksum is a finding: TCKN (10th and 11th digit algorithm, first digit not 0, no longer digit run)
  and TR IBAN (`TR` + 24 digits, spaces allowed, ISO 13616 mod-97 = 1).
- Contact data (BA-26): `redact(text, { personal: true })` also replaces e-mail addresses (`email`) and Turkish mobile or landline numbers
  (`tr-phone`, `+90` or a leading `0` followed by a 3-digit area code starting with 2 to 5). These spans are output-only: `scanText` and the
  write paths never block on them, because wiki pages may legitimately hold contact details. The prompt hook uses this option.

## Errors
- `TypeError` for non-string input or an invalid custom rule. Callers translate a non-empty finding list into their own refusal code
  (`E_SECRET_DETECTED` for MCP/checkpoint/sync writes; hooks redact instead of refusing).

## Rule catalogue (BA-26 additions)
Existing rule ids are unchanged. New content rules: `azure-storage-key` (`AccountKey=` or `SharedAccessKey=` with a value of 32 or more
base64 characters), `azure-sas-token` (`sv=<date>&…&sig=` with at least 20 signature characters), `bearer-token` (an `Authorization: Bearer`
value of 20 or more token characters that contains a digit), `gitlab-pat` (`glpat-` plus exactly 20 characters), and `azure-devops-pat`
(52 base32 characters only after a key that starts with `azure`, `ado` or `pat`, such as `ADO_PAT=`, or as the password in a `dev.azure.com` URL; keys such as `my_ado_pat` are not matched).
Turkish explicit keys `sifre`, `şifre` and `parola` are secret keys only as the whole last segment of a key (`db_parola`, `sifre`); a key such
as `sifreleme_yontemi` or `sifre_kurali` is not.
Placeholders are excluded: `<…>`, `${…}`, `$NAME`, `xxx…`, `changeme`, and a run of 20 (or 8 for URL passwords) identical characters.
The `secret-assignment` rule still reports `password_policy: "strict"` (pre-existing: an unanchored `password` key). It is not changed here.
Measurement is pending: the BA-26 developer tests use hand-written positives and negatives only; the independent test set decides the
recall and false-positive figures.

## Example
```js
if (scanText(body).length || scanPath(rel).length) throw new BrainAtlasError('E_SECRET_DETECTED', 'write refused: secret-like content');
```

## Security
Never log, return or persist the matched value. Performance: 1 MB < 200 ms; linear-time patterns (adversarial 100 KB inputs tested).
Measured (C3 blind test, unseen synthetic set): 72/72 positives detected, 0/97 false positives.
