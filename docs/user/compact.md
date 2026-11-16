# Archive old dated sections (`brainatlas compact`)

`brainatlas compact` moves the older dated H2 sections of one Wiki page, byte for byte, into an archive page and leaves
a back-link where they were. A dated section is a `## ` heading that contains a valid `YYYY-MM-DD` date, for example
`## Pass 476 — notes (2026-10-16)` or `## 2026-10-18 — summary`. Fenced code, H1 headings and H3 headings follow the
rules below. No model, no network and no retrieval index change is involved.

```text
brainatlas compact --page wiki/<path>.md (--plan | --apply) [--keep N] [--older-than YYYY-MM-DD] [--vault PATH] [--json]
```

- `--page wiki/<path>.md`: the page to compact, relative to the vault. It must be a regular file under `wiki/`. The
  path may not contain `..`, `.`, empty segments or backslashes, and it may not be `wiki/index.md`, `wiki/log.md`, a
  page under `wiki/archive/` or the Wiki lock file. The page, its parent directories and the archive location may not
  be symlinks. Violations fail with `E_PATH_ESCAPE`; a missing page fails with `E_NOT_FOUND`. Errors never include page
  text.
- `--plan`: read-only. Prints what would move and writes nothing.
- `--apply`: writes the archive page, then the page, then one `compact` entry in `wiki/log.md`. Exactly one of
  `--plan` and `--apply` is required.
- `--keep N`: keep the `N` newest dated sections in the page (an integer from 0 to 1000, default 3). The order is by
  date; sections with the same date keep the later page position first.
- `--older-than YYYY-MM-DD`: also move dated sections beyond `--keep` only when their date is strictly before this
  calendar date.
- `--vault PATH`: compact a page in this vault. Without it, the configured vault is used.
- `--json`: print one JSON object instead of the text summary.

## What moves

- The archive page is `wiki/archive/<name>-history.md`, where `<name>` is the page path without `wiki/` and `.md` and
  with every `/` replaced by `--`. `wiki/concepts/x.md` becomes `wiki/archive/concepts--x-history.md`.
- Only dated H2 sections move. A section whose heading contains `current` or `güncel durum` never moves, and the
  `## Archived history` back-link section never moves. H1 headings, undated sections and anything before the first H2
  stay in the page.
- A `## ` line inside a fenced code block is not a section start. A fence inside a moved section moves with it, and so
  do its H3 headings.
- Moved sections are appended to the archive in their original document order. A new archive page starts with
  frontmatter (`type: archive`, `status: archived`, `archived_from`, `generated`) and a `# History:` heading. An
  existing archive page is appended to only when its `archived_from` names the same page; otherwise the command fails
  with `E_CONFLICT` and changes nothing.
- The page keeps every other byte. If it has no `## Archived history` section, one is appended with a link to the
  archive page.
- Running `--apply` again with the same options moves nothing and writes nothing.

Before writing, the command checks that the page lost exactly the moved lines and that the moved lines form one
contiguous block at the end of the archive. If that check fails it fails with `E_INTERNAL` and writes nothing. The
result reports `lineLoss: 0`.

## Output

Without `--json` the output is one line for the command, one line with the move counts and word counts, one line per
moved section, and, after an apply that wrote files, an undo line:

```text
compact apply: wiki/concepts/x.md → wiki/archive/concepts--x-history.md
moved 3 section(s), 12 line(s); kept 3 dated; words 1840 → 900
- 2026-10-01  Pass 470 — notes
- 2026-10-05  Pass 471 — notes
- 2026-10-10  Pass 472 — notes
To undo: copy the sections listed under "moved" from wiki/archive/concepts--x-history.md back into wiki/concepts/x.md and delete its "## Archived history" section.
```

Use `--plan` first and review the listed headings before `--apply`.
