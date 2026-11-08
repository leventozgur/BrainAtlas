# Demo recording script

Suggested short screen recording; use a disposable test vault with fictional content.

1. Show a terminal and install a local Lite release archive. Avoid showing personal paths or credentials.
2. Run `brainatlas init --profile lite --agents claude-code` and show the adapter plan/trust review.
3. Open the test Wiki and show a page with a source and verification record.
4. Ask the coding agent a project question. Show it calling `wiki_query`, then reading the matching page before answering.
5. Run `brainatlas doctor` and show the passing checks.
6. End on the concise message: “Local evidence, retrieved when your coding agent needs it.”

Do not show real project data, secret values, user names, home-directory paths, or remote sync credentials. If illustrating sync, label it experimental where applicable and use fake data.
