# Release Packaging Verification Map

| Spec Area                   | Existing Coverage                                            | Layer         | Files                                                    | Status | Notes                                      |
| --------------------------- | ------------------------------------------------------------ | ------------- | -------------------------------------------------------- | ------ | ------------------------------------------ |
| Publishable package list    | non-private package manifests compared to release/docs lists | Script        | `scripts/check-release-config.mjs`, `pnpm release:check` | keep   | Primary drift check.                       |
| Version bump list           | bump script package list aligned with publishable packages   | Script        | `scripts/bump-release-versions.mjs`, `release:check`     | keep   | Does not rewrite dependency ranges.        |
| Craft targets               | target ids aligned with publishable packages                 | Script/manual | `.craft.yml`, `release:check`                            | keep   | IncludeNames patterns still hand-reviewed. |
| CI pack artifacts           | every publishable package packed on push                     | CI            | `.github/workflows/ci.yml`                               | keep   | Artifacts uploaded with no-files error.    |
| Release workflow            | manual bump/force, app token, Craft prepare                  | CI/manual     | `.github/workflows/release.yml`                          | keep   | Requires repo/org secret/variable config.  |
| README/docs package list    | package inventories aligned                                  | Script        | `README.md`, `CONTRIBUTING.md`, release docs             | keep   | `release:check` checks anchored sections.  |
| Tarball content correctness | package `files` and build outputs                            | Partial       | package tests, pack commands                             | gap    | Add unpack check if needed.                |
