# Wiki maintenance report (`brainatlas maintain`)

`brainatlas maintain` reads the Wiki and prints a maintenance report: stale pages, broken links, orphan pages, index
problems, oversized pages and pages with many dated Update sections. It is read-only. It never edits a page or the index.

```text
brainatlas maintain [--json] [--vault PATH] [--queue] [--repo DIR]
```

- `--vault PATH`: scan this vault. Without it, the configured vault is scanned.
- `--repo DIR`: also check code references against the working tree at `DIR`. Only the files are read: no git command
  runs and nothing is written. Without `--repo`, no repository is read. A missing or non-directory `DIR` fails with
  `E_REPO_MISSING`.
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

`stale-source` and `stale-symbol` appear in `findings`, the human output and `--queue` receipt candidates, not in
`counts`. `counts` keeps the same keys as before.

### Code references (`--repo`)

- `sources: ["repo:src/total.mjs"]` and `sources: ["repo:src/total.mjs@<commit>"]` both check `src/total.mjs`. The
  commit is **not verified** (no git runs). The suffix is removed only when it is 7 to 64 hexadecimal digits, in any
  case. Other text after the last `@`, such as a branch name, stays part of the path, so `repo:src/a.mjs@main` reports
  `stale-source`. Write the path without that suffix.
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
- The report reads only. It has no fix or apply mode. Changes to the Wiki still go through a person.
