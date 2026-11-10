---
title: Export formats
status: active
generated: "2026-05-27"
---
# Export formats

Exports can be produced as JSON lines, as comma separated tables, or as a folder of markdown pages. The format is selected with the export command and defaults to markdown pages, which keeps the output readable without special tools.

## Choosing a format
JSON lines suit pipelines that load records one by one. Tables suit spreadsheet review. The markdown folder keeps headings and links, so it is the format to use for handing knowledge to another team.

## Contents
Exports include page bodies and frontmatter but never include the credential store or the state directory. Exports of audit records follow the retention rules in [[data/retention]].

## Verification
Each export writes a manifest with the page count and a checksum of the output. The manifest is enough to confirm that a copy is complete.

## Size limits
Very large exports are split into numbered parts. Each part has its own manifest entry, and the manifest records the total number of parts so that a missing part is easy to detect.
