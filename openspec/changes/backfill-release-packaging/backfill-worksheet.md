# Release Packaging Backfill Worksheet

## Canonical Spec

- New spec: `release-packaging`

## Local Artifacts Reviewed

- `.craft.yml`
- `.github/workflows/ci.yml`
- `.github/workflows/release.yml`
- `scripts/check-release-config.mjs`
- `scripts/bump-release-versions.mjs`
- `scripts/craft-pre-release.sh`
- `README.md`
- `CONTRIBUTING.md`
- `packages/docs/src/content/docs/contribute/releasing.md`
- `packages/*/package.json`
- `packages/junior/skills/junior/references/packaging.md`

## External Sources

- npm package.json docs: https://docs.npmjs.com/files/package.json/
- npm pack docs: https://docs.npmjs.com/cli/v11/commands/npm-pack/
- pnpm filtering docs: https://pnpm.io/filtering
- pnpm pack docs: https://pnpm.io/cli/pack
- GitHub Actions artifacts docs: https://docs.github.com/en/actions/using-workflows/storing-workflow-data-as-artifacts
- actions/upload-artifact docs: https://github.com/actions/upload-artifact
- Sentry Craft docs: https://www.npmjs.com/package/@sentry/craft

## Current Behavior Summary

- Public packages release in lockstep.
- Publishable package list is derived from non-private package manifests.
- `release:check` compares release/documentation package lists against publishable package manifests.
- Craft `preReleaseCommand` calls the version bump script.
- CI runs `release:check`, then packs each publishable package on push, uploads tarballs, and fails when no artifact files are found.
- Release workflow delegates release preparation to `getsentry/action-prepare-release`.

## Undefined Behavior

| Question                                                              | Current Evidence                                    | Candidate Decision                                                        | Status |
| --------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------- | ------ |
| Should tarball contents be unpacked and checked?                      | CI packs tarballs but does not inspect files.       | Add a pack-content check if package file regressions occur.               | open   |
| Should release workflow Node version match app/scaffold Node version? | Release uses Node 20; CI/scaffold docs use Node 24. | Document release workflow runtime separately or align to Node 24.         | open   |
| Should internal workspace dependency ranges be rewritten on release?  | Version bump only updates package `version` fields. | Keep workspace protocol unless npm publish output proves a problem.       | open   |
| Should Craft includeNames be generated?                               | Patterns are hand-written in `.craft.yml`.          | Keep checked by `release:check`; generate only if drift remains frequent. | open   |
| Should docs deployment be coupled to package releases?                | Releasing docs mention docs deployment separately.  | Keep docs deployment as separate docs-site concern.                       | open   |

## Validation

- `openspec validate backfill-release-packaging --strict` passed.
