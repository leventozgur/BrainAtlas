# THIRD_PARTY_NOTICES check

## Vendored @llmwiki/core

- `vendor/llmwiki-core/LICENSE` and `vendor/llmwiki-core/NOTICE` exist; `VENDORED.md` identifies Microsoft llmwiki `packages/core`, MIT, upstream tag `v1.0.1`, commit `e09126f257c1fcf8e63234382748a51cf6a5df7f` (`vendor/llmwiki-core/VENDORED.md:5-11`).
- Recomputed with Node from the sorted SHA-256 listing of all `dist/` files: **48 files**, tree hash `b0643613339cde38a55c20e2e9d8418916b61234c5d3166fa329304313e3aa24`. This matches `VENDORED.md:10-13`.
- The vendored upstream package is MIT and its license/notice documents are present. The release builder traverses the vendor directory, so these documents are included in releases (`release/build-release.mjs:10-11, 17-18`).

## npm dependency attribution

- The lockfile inventory is in [dependencies.md](./dependencies.md). It lists all 106 external package instances (102 distinct names), including nested installs, with their installed package metadata licenses.
- All listed npm licenses are MIT, ISC, BSD-2-Clause, or BSD-3-Clause; none falls outside the allowed MIT/ISC/BSD/Apache-2.0 family. Preserve package copyright and license terms when redistributing. MIT/ISC/BSD generally require retaining copyright, permission, and disclaimer text; Apache-2.0 also requires its license and any applicable NOTICE attributions. Release packaging copies dependency package directories (`release/build-release.mjs:48-68`), retaining package-local license files where present.
- `THIRD_PARTY_NOTICES:6` currently says a complete npm inventory “will be generated in the AUDIT track.” This report now supplies that inventory, but the shipped notice still points to future work rather than the inventory or an assembled attribution bundle.

## Open notice items

- `THIRD_PARTY_NOTICES:5` has unresolved `TODO(PM)` to confirm the design-pattern source URL and copyright line. The notice names “avenoxbeyin” and says patterns only/no copied code, but source attribution remains unverified.
- `THIRD_PARTY_NOTICES:6` is stale after this audit and should be updated to point to the completed license inventory and clarify release attribution handling.
- `THIRD_PARTY_NOTICES:4` correctly points to the vendored MIT license. Vendored `NOTICE` also contains upstream contributor contact metadata; its line locations are listed as email-class privacy matches in [privacy.md](./privacy.md).
