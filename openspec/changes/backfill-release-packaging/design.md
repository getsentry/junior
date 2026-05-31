# Design: Release Packaging Baseline

## Sources Reviewed

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

External primary sources reviewed:

- npm `package.json` docs: `name` and `version` identify published packages; `private: true` prevents publish; `publishConfig` controls publish-time config such as public scoped-package access; `files`, `exports`, and `bin` define public artifact surfaces.
- npm `pack` docs: package tarballs are the publishable artifact shape used to inspect package contents before publish.
- pnpm filtering/pack docs: `pnpm --filter <package> pack --pack-destination <dir>` is the workspace-scoped artifact creation primitive used in CI.
- GitHub Actions artifact docs: upload-artifact can fail when no files are found and supports bounded retention.
- Sentry Craft docs: Craft uses `.craft.yml`, a pre-release command for version bumping, artifact publishing targets, and target `includeNames` filters.

## Current Inventory

Publishable packages are every `packages/*/package.json` where `private !== true`:

- `@sentry/junior`
- `@sentry/junior-plugin-api`
- `@sentry/junior-agent-browser`
- `@sentry/junior-datadog`
- `@sentry/junior-github`
- `@sentry/junior-hex`
- `@sentry/junior-linear`
- `@sentry/junior-notion`
- `@sentry/junior-scheduler`
- `@sentry/junior-sentry`

Private packages are not part of the public lockstep release inventory:

- `@sentry/junior-docs`
- `@sentry/junior-evals`
- `@sentry/junior-testing`

## Release Flow

1. Release workflow calculates a semver bump from `packages/junior/package.json`.
2. `getsentry/action-prepare-release` runs Craft preparation.
3. Craft invokes `scripts/craft-pre-release.sh` with old/new versions.
4. The pre-release script calls `scripts/bump-release-versions.mjs <new-version>`.
5. CI runs `pnpm release:check`.
6. Push CI packs each public package into `artifacts`.
7. Upload artifact stores `artifacts/*.tgz` with `if-no-files-found: error`.
8. Craft publishes npm targets whose `includeNames` match the tarball names.

## Drift Check

`scripts/check-release-config.mjs` treats `packages/*/package.json` publishable package names as expected and compares them with:

- `.craft.yml`
- `scripts/bump-release-versions.mjs`
- `.github/workflows/ci.yml`
- `README.md`
- `CONTRIBUTING.md`
- `packages/docs/src/content/docs/contribute/releasing.md`

This is the right ownership model: package metadata is the source of truth; every list that drives release or documents package inventory must align to it.

## Undefined Behavior

- Artifact content is not currently checked by unpacking the generated tarballs; package `files` and build outputs are trusted through package tests and pack commands.
- Release workflow sets Node 20 while docs quickstart now documents Node 24 for scaffolded apps and CI uses Node 24. The release workflow may not need Node 24, but the policy is not documented.
- `scripts/bump-release-versions.mjs` updates package versions only. It does not update internal dependency ranges, which currently use workspace references where needed.
- Craft target `includeNames` patterns are hand-written and only indirectly checked through package names and CI pack commands.
- There is no dry-run release command documented beyond `pnpm release:check` and CI pack artifacts.

## Verification Strategy

- `pnpm release:check` is the primary deterministic drift check.
- CI pack artifact creation verifies that listed packages can produce tarballs.
- Package-local build/type/test checks verify generated output before artifacts are packed.
- Future stronger coverage can unpack tarballs and assert required files for public packages.
