# Wiki maintenance (`brainatlas maintain`)

`brainatlas maintain` reads the Wiki and prints a maintenance report: stale pages, broken links, orphan pages, index
problems, oversized pages and pages with many dated Update sections. The report is read-only: it never edits a page or
the index. The opt-in `--fix` mode repairs the mechanical findings described below.

```text
brainatlas maintain [--json] [--vault PATH] [--queue] [--repo DIR]
brainatlas maintain --fix (--plan | --apply) [--sources] [--vault PATH] [--json]
```

- `--vault PATH`: scan this vault. Without it, the configured vault is scanned.
- `--repo DIR`: also check code references against the working tree at `DIR`. Only the files are read and only read-only
  git commands run (to verify a commit suffix): nothing is written and no network is used. Without `--repo`, no repository
  is read and no git process starts. A missing or non-directory `DIR` fails with `E_REPO_MISSING`.
- `--json`: print one JSON object: `{ok, findings, counts, pages, durationMs}`. Errors use the usual shape
  `{ok:false, error:{code, message}}`.
- `--queue`: add one review candidate per finding kind to the receipts queue, for approval with `brainatlas review`.
  Only the configured vault can be queued. The Lite profile has no receipts module, so nothing is written and the report
  says so.

## Findings

Each finding is `{kind, path, detail}`. `detail` holds counts, paths, field names or short link targets. It never holds
page content.

| Kind | Meaning |
| --- | --- |
| `stale` | `stale_after` has passed (a date, or `generated` plus `PnD`/`PnW`). |
| `superseded-broken` | `superseded_by` is missing or points to a missing page, to a page that is itself superseded, or loops. |
| `broken-link` | A wikilink or a relative link to a Markdown page does not resolve, or a wikilink name is ambiguous. |
| `orphan` | No other page links to the page and it is not listed in the index. |
| `index-missing` | A page is not listed in `wiki/index.md`. A missing index is one finding for `wiki/index.md`. |
| `index-stale` | An index entry points to a page that does not exist. |
| `oversized` | The page body has more than 3000 words. |
| `update-sprawl` | The page has 6 or more dated `Update` or `Güncelleme` headings. |
| `stale-source` | Only with `--repo`: a `sources` entry `repo:<path>[@<commit>]`, or the file of a `symbols:` entry, is not a regular file in the repository. |
| `stale-symbol` | Only with `--repo`: a `symbols:` name is not found, as a whole word, in its repository file. |
| `unknown-commit` | Only with `--repo`: the commit of a `repo:<path>@<commit>` source does not exist in the repository. |
| `source-drift` | Only with `--repo`: the file of a `repo:<path>@<commit>` source changed between that commit and `HEAD`. |
| `unverifiable` | Only with `--repo`: the commit cannot be checked — git is missing, `DIR` is not a work tree, `HEAD` does not resolve, the clone is shallow or a git call timed out. |

`stale-source`, `stale-symbol`, `unknown-commit`, `source-drift` and `unverifiable` appear in `findings`, the human output
and `--queue` receipt candidates, not in `counts`. `counts` keeps the same keys as before.

For an `oversized` page, `brainatlas compact` moves its older dated sections verbatim into
`wiki/archive/<name>-history.md` (see [compact](compact.md)).

### Code references (`--repo`)

- `sources: ["repo:src/total.mjs"]` and `sources: ["repo:src/total.mjs@<commit>"]` both check `src/total.mjs`. The
  suffix is removed only when it is 7 to 64 hexadecimal digits, in any case. Other text after the last `@`, such as a
  branch name, stays part of the path, so `repo:src/a.mjs@main` reports `stale-source`. Write the path without that
  suffix.
- A commit suffix is verified with read-only git (`execFile`, no shell, 5 s per call): an existing commit is accepted, a
  commit that is not in the repository is `unknown-commit`, and a changed file is `source-drift` with `changed since
  <7 chars>: <path>`. Drift compares the commit with `HEAD` only, so uncommitted working-tree changes are ignored. A
  source without a commit never starts git.
- Git must be installed and `DIR` must be a work tree whose `HEAD` resolves; otherwise every checked commit is
  `unverifiable` (`commit cannot be verified: <7 chars>`) and no `unknown-commit` or `source-drift` is reported. A
  shallow clone (such as `git clone --depth 1`) also gives `unverifiable` for a commit it does not contain, and any git
  call that times out is unverifiable too. Nothing is written: no checkout, no fetch, no network.
- A missing or rejected path still gets its `stale-source` and its commit is still checked, but drift is not checked for
  it. One page reports at most one finding per kind, commit and path; one commit used for several paths is checked once.
- A path is checked as a regular file, one component at a time. A symlink anywhere on the way is not followed, so it is
  reported as missing. A directory is not a file.
- A path that is absolute, has a backslash or a drive letter, contains a `..` segment, ends with `/`, or is empty is
  rejected. It is reported as `stale-source` with a fixed detail (`repo path is not a file path inside the repository`),
  and the path itself is not echoed.
- Optional `symbols:` list in the page frontmatter. Each entry is `{path: src/total.mjs, name: computeTotal}` or the
  string `"src/total.mjs#computeTotal"`. The name follows the last `#`. The name must appear as plain text, bounded at both
  ends by a non-letter, non-digit, non-underscore character. It is not a regular expression, and `Foo` does not match
  `FooBar`.
- Malformed `symbols:` entries are ignored silently. This covers a non-object and non-string entry, a missing or empty
  path or name, a name with a line break or longer than 200 characters, and a `symbols:` value that is not a list.
- A missing file named twice on one page, by a source and a symbol, is one `stale-source` finding.

## Rules

- Scanned: Markdown files under `wiki/`. `wiki/index.md` and `wiki/log.md` are not checked as content pages.
- Symlinks are never followed. A symlinked page, directory or `wiki/` folder is skipped.
- Code is ignored: fenced blocks and inline code do not produce links.
- Wikilinks: `[[name]]`, `[[name|label]]` and `[[name#section]]` resolve by exact path (without `.md`), then by path
  suffix, file name, title or alias. Case and diacritics are folded. Sections are not checked.
- Markdown links are resolved from the page's own folder. Anchors are not checked. Links to non-Markdown files and
  external URLs are ignored. A link that leaves the vault is ignored, not reported.
- The index is read the same way as the MCP coverage check: entries are relative to `wiki/`, fenced lines are skipped,
  and escaped parentheses, angle-bracket destinations and anchors are understood.
- `superseded-broken` also reports a superseded page whose replacement is itself superseded. Follow the chain to its
  final replacement to clear the finding.

## Notes

- Thresholds (3000 words, 6 dated Update sections) are fixed in this release.
- The report reads only. Without `--fix`, no page and no index line is ever changed; it has no apply mode.

## Fix mode (`--fix`)

`--fix` repairs three mechanical classes and reports everything else. Exactly one of `--plan` or `--apply` is required,
and `--fix` cannot be combined with `--queue` or `--repo`. `--sources` is only valid together with `--fix`.

```text
brainatlas maintain --fix (--plan | --apply) [--sources] [--vault PATH] [--json]
```

- `--plan` reads the Wiki and prints the exact changes it would make. It writes nothing: no page, no index line, no
  `wiki/log.md` entry, no lock file.
- `--apply` recomputes the same plan from a fresh read inside the Wiki write lock, then writes each changed file
  atomically and appends one `wiki/log.md` entry per changed file: `- <ISO> {"action":"maintain-fix","path":"wiki/..."}`.
  The entry carries no page text, titles, summaries, counts or change kinds. Running it again immediately changes nothing
  and writes no log entry.
- `--sources` also fills missing `## Source files` lists (see below). Without it, only the index and archived links are
  repaired.
- `--json` prints one object: `{ok, mode, changes, unfixed, counts, written, durationMs}`.

Each change is `{kind, path, line, before, after}`. `line` is the 1-based line number in the file before the change, and
`after` is the new line; appended lines have `before: null` and their new line number. Changes are sorted by path, then
line. `counts` has exactly the keys `index-missing`, `archived-link` and `source-link`. Unfixed items are
`{kind, path, detail, reason}`.

| Class | What is repaired |
| --- | --- |
| `index-missing` | One index list line is appended to `wiki/index.md` for each content page the index does not list: the title links to the page path, followed by ` — ` and the summary when there is one. |
| `archived-link` | A broken wikilink whose name matches exactly one regular file under the vault-root `archive/` folder becomes plain text: ``<Alias or Name> (archived: `archive/<path>.md`)``. |
| `source-link` | With `--sources`: existing vault-relative `sources` entries the body does not link to are listed under `## Source files`. |

Rules:

- Index lines go under the first H2 named after the page folder (`concepts` → `## Concepts`, and so on): after its last
  list line, or right after the heading when it has none. Pages with no matching section go under
  `## Unsorted (maintain --fix)` at the end of the index, which is created once.
- The index title is the frontmatter `title`, else the first `# ` heading, else the file name without `.md`. The summary
  is `summary`, else `description`: newlines collapse to one space, it is trimmed and cut to 160 characters including a
  trailing `…` when it is longer, counted in Unicode code points. Titles collapse to one line with `]` escaped, and every generated link destination is
  percent-encoded (spaces, `(`, `)`, `?`, `#`), so paths with spaces or parentheses stay a single entry on the next run.
- Archive matching is case-insensitive on the base name with an optional `.md`, with no other folding: `[[Old Thing]]`
  matches `archive/2026/old thing.md` but not `archive/old-thing.md`, and `[[Şeker]]` does not match `archive/seker.md`.
  No match leaves the link as an `unknown-target` unfixed item; several matches leave it as an
  `ambiguous-archive` broken-link item.
- A wikilink that the report calls ambiguous (the name exists on more than one page) is never rewritten to archive text:
  it stays as the report's `unknown-target` item.
- Code is never touched: links inside fenced blocks and inline code are left alone.
- Source lists only include `sources` values that are strings, start with `raw/`, `wiki/` or `archive/`, have no `..`
  segment and exist as regular files. Duplicates are dropped and an existing trailing `## Source files` section is
  extended instead of duplicated.

Safety:

- Only files inside `wiki/` are written. `raw/`, `archive/`, `planning/`, `inbox/`, `wiki/archive/` pages, `wiki/log.md`
  (outside `appendLog`) and everything outside the vault are never written.
- No line is ever deleted. Before writing, each file is checked line by line: it may differ from the original only in
  lines rewritten by `archived-link` and lines inserted by `index-missing`/`source-link`. A failed check aborts with
  `E_FIX_VERIFY` before anything is written.
- Frontmatter is never changed, including when the file starts with a UTF-8 BOM; a change that lands inside the
  frontmatter aborts the run with `E_FIX_VERIFY`.
- Symlinked pages (a name ending in `.md`) and symlinked directories are skipped and reported as `symlink`. A symlink to
  any other file, such as an image, is not a page and is ignored.
- Inserted lines reuse the file's own line ending, so a CRLF file stays CRLF.
- Report-only findings stay in `unfixed`: other broken links from the read-only report (`unknown-target`), archive matches
  that are ambiguous (`broken-link` with `ambiguous-archive`), orphan pages (`report-only`, kind `orphan`, dropped when
  this plan adds the page to the index) and a missing index (`index-absent`). Nothing else from the report is changed.

## Weekly run (`--weekly`)

```text
brainatlas maintain --weekly [--vault PATH] [--json]
```

One read-only run: the report above, the `--fix` plan (without `--sources`) and one `compact --plan` for every page the
report calls `oversized` (the newest 3 dated sections stay). Nothing is applied and the vault tree is byte-identical
afterwards. A failing compaction plan for one page is recorded as `{page, error: "<code>"}` and the run continues.

Two files are written under `<stateDir>/<vaultId>/maintenance/`:

- `weekly-YYYY-MM-DD.json` (UTC date; a second run on the same day overwrites it):
  `{ranAt, pages, counts, fix: {changes, counts, unfixed}, compact: [{page, moved, error?}], queue}`. Only paths, counts
  and error codes: never page text, titles, summaries or the vault's absolute path.
- `last-weekly.json`: `{ranAt}`.

At most twelve `weekly-*.json` snapshots are kept; the oldest ones are deleted and nothing else in that folder is
touched. The `queue` field follows `--queue`: on the configured vault the report findings, the fix plan
(`Maintenance fix plan: <n> change(s)`) and the compaction pages (`Compaction candidates: <n> page(s)`) go to the
receipts queue, with at most 20 source paths each. Another vault gives
`{queued: false, reason: "not-configured-vault"}`, no candidates give `{queued: false, reason: "no-findings"}`, and a
queue failure never fails the run. `--json` prints the snapshot object; otherwise one summary line and one queue line are
printed.

## Running it on a schedule

BrainAtlas installs no scheduler of its own: `--schedule` is not a `maintain` option and fails with `E_ARGUMENT`. To run
the weekly check automatically, schedule the command yourself, for example with a launch agent on macOS, a systemd user
timer on Linux or `cron`:

```text
<binPath> maintain --weekly
```

Plain `brainatlas maintain` (the configured vault, no `--vault`, no `--weekly`, no `--fix`) appends exactly one reminder
line when `last-weekly.json` exists for that vault and its `ranAt` is more than 8 days old; with `--json` the report also
carries `weekly: {lastRun, overdue: true}` in exactly that case. A vault that never ran `--weekly` gets no reminder, and
`--vault` runs never do. The check only reads the state directory: it starts no background process and writes nothing.

## Current-state proposals (`maintain.synthesis`)

`maintain --weekly` can ask an external model command for a "current state" proposal per selected page. It is off by
default; enable it with `brainatlas config set maintain.synthesis.mode shadow` (or `on`) and give it an argv command, for
example `brainatlas config set maintain.synthesis.command '["claude","-p","--model","claude-haiku-5-5"]'`. The command
receives the fixed English prompt on stdin and must print one JSON object matching the phase B1 proposal schema; a Claude
Code `--output-format json` envelope with a `result` string is accepted too. Only a transport failure (a thrown error, a
timeout or a non-zero exit) is retried, once, with the same command.

The step runs after the read-only weekly steps and honours the weekly budget: `maxCallsPerWeek` calls and
`maxUsdPerWeek` estimated dollars (`usdPer1kTokens` per 1000 estimated tokens, `timeoutMs` per call). The ledger lives at
`<stateDir>/<vaultId>/synthesis/ledger.json` keyed by ISO week (`{"<YYYY-Www>": {calls, estUsd}}`). Two unreviewed proposal
batches pause the model step (`review-backlog`). At most `pagesPerWeek` pages are picked, skipping pages that already have
an open proposal or were edited in the last seven days, and the page plus its archive are truncated to
`maxInputChars` (archive first); a page that does not fit alone is skipped as `too-large`.

Every proposal is saved for review under `<stateDir>/<vaultId>/synthesis/proposals/`; a shadow record carries
`shadow: true`. Gate failures are stored as `gate-failed`, unparsable or schema-invalid output as `rejected-schema` (with
`proposal: null` and only the truncated schema errors), and neither is reviewable. `maintain --weekly --json` adds
`synthesis: {ran, reason?, batch, proposals: [{id, page, status, failures}], ledger}` to the snapshot and one queue
candidate, `Current-state proposals: <n> page(s)`, when at least one stored proposal is open: `n` counts only `open`
records and the sources are their page paths, so `gate-failed` and `rejected-schema` records are never queued. A failing
synthesis step is recorded as `{ran: false, reason: "error", code}` and never fails the weekly run; a ledger that is not a
JSON object is reported as `E_LEDGER_CORRUPT` and is never overwritten. A `--vault` outside the configured vault records
`{ran: false, reason: "not-configured-vault"}` without calling the command.
This phase never writes inside the vault: the page text is only sent to the command and the proposal is only stored.

### Data sent to the model

Pages marked `sensitivity: personal` or `inject: never` in their frontmatter (trimmed, case-insensitive) are never sent:
they are dropped before target selection and never charge the ledger, and the run reports `excluded: <count>` when it
dropped at least one page. The built prompt and the model's stdout are scanned for secrets before use: a finding skips
the page as `unsafe-input` (no call, nothing stored, no ledger charge) or `unsafe-output` (the call stays charged,
nothing is stored, not even a `rejected-schema` record), and the skip lists only the sorted rule ids, never the matched
text. Proposal records and the ledger are written with mode `0600` inside `0700` directories. With `BRAINATLAS_OFFLINE=1`
the model step is skipped entirely (`{ran: false, reason: "offline"}`) and the weekly run still finishes normally. The
model command inherits the full environment of the `brainatlas` process; it is not filtered. `maintain --proposals accept`
refuses a vault that is not the configured vault with `E_NOT_CONFIGURED_VAULT` before reading any proposal.

## Reviewing current-state proposals (`maintain --proposals`)

Stored proposals are reviewed with `brainatlas maintain --proposals list|show <id>|accept <id>|reject <id> [--vault PATH] [--json]`.
The command reads the per-vault proposal store under `<stateDir>/<vaultId>/synthesis/proposals/`; `--vault` only changes which
vault is reviewed, not where the records live.

- `list` marks records whose `expiresAt` has passed as `expired` and prints the remaining open records, newest first: `id`,
  `page`, `batch`, `createdAt`, `expiresAt`, `shadow` and the gate status. It never prints page or proposal text.
- `show <id>` prints the delta summary first (dropped sentences, changed numbers, lost caveats, block words, conflicts), then the
  rendered block and a unified diff recomputed from the current page. If the page hash no longer equals the record's `baseHash`,
  the record becomes `invalidated` and the result carries `reason: "page-changed"`; the command still exits 0.
- `reject <id>` only sets the record status to `rejected`.
- `accept <id>` refuses with `E_PROPOSAL_STATE` unless the record is open, with `E_PROPOSAL_SHADOW` for a shadow record, with
  `E_PROPOSAL_EXPIRED` when it has expired, with `E_PROPOSAL_STALE` (and marks it `invalidated`) when the page changed, and with
  `E_CONFLICTED_COPY` when the page folder or `wiki/archive/` contains a conflicted copy. Otherwise it takes the Wiki write lock,
  re-reads and re-checks the page, runs the `--keep 3` compaction (a compaction error refuses the apply) and the five gates on the
  exact texts, records the retrieval rank of the title and up to four keyword queries, writes the archive and then the page
  atomically, and verifies both by reading them back. A failing pre-apply Core lint refuses with `E_APPLY_CHECK`; a mismatch after
  writing restores the originals and fails with `E_APPLY_VERIFY`. After the write, Core lint, the OKF page check and the retrieval
  ranks (top ten, no more than two places worse) are compared with the pre-apply baseline; any regression restores both files,
  sets the record to `reverted` and fails with `E_APPLY_REGRESSION` naming only the failing checks. Any other post-write error
  (including a failing `appendLog`) also restores both files before the original error is rethrown; if a restore step itself fails
  the command reports `E_APPLY_RESTORE_FAILED` with file names only. A successful apply appends one content-free `synthesis-accept`
  entry to `wiki/log.md`, sets the record to `accepted`, and leaves the page frontmatter `status` unchanged except that conflicts
  set it to `disputed`.

Accepted blocks are labelled `[synthesized]` in search results and hook output: the block is model-written and human-approved, not verified evidence, so a `confirmed` page's `verified` trust is not shown for that section even though the page keeps it.

No model is called in this phase itself. Since phase B2, `maintain --weekly` can call the configured model command when
`maintain.synthesis.mode` is `shadow` or `on`, but `--weekly` still never writes the vault.

