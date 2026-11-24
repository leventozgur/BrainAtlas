# 0.1.0 final exit criteria

This page defines when a `0.1.0-rc.N` pre-release may be promoted to `0.1.0`. It is a checklist, not a contract; the artifact format and signing rules live in [`contracts/release.md`](contracts/release.md).

Promotion is a maintainer decision. Every item below must be met by the candidate commit, and the result of each check is recorded in the release pull request.

## Must pass

1. **Verified artifacts.** `npm run build:release` followed by `npm run release:verify` passes every step for the candidate commit.
2. **Full gate on CI.** `npm test`, `npm run lint`, `npm run typecheck` and `npm run guard` pass on all six CI jobs (macOS and Ubuntu on Node 20, 22 and 24). Perf tests are advisory and do not block. The suite must also pass with the clock shifted forward (see CONTRIBUTING.md, "Checking for date time-bombs"), apart from the known shift artifacts listed there.
3. **No known open correctness bug.** No open issue or planned item labelled as a bug against the released code paths (retrieval, hooks, MCP, sync, install/update). Known accepted risks are listed in item 7.
4. **Installed-release check.** On at least one real machine, `brainatlas update` then `brainatlas doctor` is clean, and `brainatlas usage` shows the hook semantic path used (`semantic: used`, no `module-missing`) over a week of normal use when the semantic module is enabled.
5. **Soak.** The last rc has been installed for at least 7 days on the maintainer's primary machine with no rollback and no data-loss report.
6. **Documentation matches behaviour.** README and `docs/user/*` describe the shipped commands and defaults. Features still marked "experimental" in `module.json` or the docs are listed in the release notes with that label.
7. **Accepted risks are written down.** Each skipped or `todo` test has a documented reason. These include the four index-cache content-forgery `todo` findings in `tests/acceptance/BA-02/cache-fuzz.test.mjs`, accepted in [`contracts/retrieval.md`](contracts/retrieval.md).
8. **Repository hygiene.** Release tags are annotated or at least point at the release merge commit; merged release and experiment branches are deleted from the remote.

## Experimental labels

A feature may drop its "experimental" label for 0.1.0 only after a deliberate review of its test matrix. Until then it keeps the label in README, the user docs and `module.json`. For 0.1.0 these are semantic retrieval, Git/folder/Dropbox sync, the local panel (`brainatlas ui`) and the `maintain-schedule` module; check that `module.json` and the docs agree before promotion.

## Not required

- Perf thresholds (advisory CI job).
- Optional modules that are off by default, beyond item 6.

## Process

1. Cut `release-rc.N` with version bump and changelog.
2. Verify items 1 to 3 on its CI run.
3. Install the rc and run items 4 and 5.
4. When all items pass, bump to `0.1.0`, rebuild, rerun `release:verify`, tag and publish as a non-pre-release.
