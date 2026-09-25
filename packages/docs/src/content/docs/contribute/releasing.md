---
title: Releasing
description: Package and docs release process.
type: tutorial
prerequisites:
  - /contribute/testing/
related:
  - /contribute/development/
  - /start-here/verify-and-troubleshoot/
---

Junior uses lockstep package releases for:

- `@sentry/junior`
- `@sentry/junior-plugin-api`
- `@sentry/junior-agent-browser`
- `@sentry/junior-amplitude`
- `@sentry/junior-cloudflare`
- `@sentry/junior-dashboard`
- `@sentry/junior-datadog`
- `@sentry/junior-github`
- `@sentry/junior-gocd`
- `@sentry/junior-hex`
- `@sentry/junior-linear`
- `@sentry/junior-maintenance`
- `@sentry/junior-memory`
- `@sentry/junior-notion`
- `@sentry/junior-octolens`
- `@sentry/junior-sentry`
- `@sentry/junior-vercel`

## Package release

1. Open GitHub Actions `Release` workflow.
2. Choose bump (`patch`, `minor`, `major`).
3. Use `force=true` only when intentionally bypassing blockers.

Required configuration:

- Variable: `SENTRY_RELEASE_BOT_CLIENT_ID`
- Secret: `SENTRY_RELEASE_BOT_PRIVATE_KEY`
- npm publish credentials for release runtime

### GitHub packages

Craft keeps the existing publish approval. Its first target creates the release
version tag. The `Publish GitHub release` workflow handles the tag's `create`
event. Craft then publishes npm packages without waiting for that workflow.
The release bot must use an app token for tag creation. A repository
`GITHUB_TOKEN` does not start another workflow from a tag event.

CI packs each package once. Before uploading the artifact, it checks every
publishable package against `packages/*/package.json`. It rejects missing or
duplicate packages, mixed versions, unresolved workspace dependencies, and
Junior dependencies outside the release set.

The CI artifact includes `junior-release.json`:

```json
{
  "version": "0.227.0",
  "commit": "<full release commit SHA>",
  "packages": [
    {
      "name": "@sentry/junior",
      "version": "0.227.0",
      "file": "sentry-junior-0.227.0.tgz",
      "sha256": "<SHA-256 hex digest>",
      "dependencies": { "@sentry/junior-plugin-api": "0.227.0" }
    }
  ]
}
```

The example shows one package. The real manifest contains all publishable
packages. `dependencies` contains Junior dependencies from the packed runtime,
optional, and peer dependency sections. Junior packages use exact release
versions. External packages still come from npm.

The tag workflow requires exactly one unexpired artifact named for the tagged
commit. Its owning run must be a successful push run of `ci.yml`. Craft selects
artifacts by that same commit name. If a rerun leaves more than one artifact,
publication stops for manual review instead of selecting different bytes.
Do not rerun packaging for a commit while its release is in progress.
The tag workflow does not rebuild packages or read npm availability.
It creates a draft GitHub Release with the release notes from the tagged
`CHANGELOG.md`. It uploads the tarballs and manifest, downloads them again,
and compares them with CI. It then installs the full package set in a temporary
consumer with a fresh pnpm store and overrides for all Junior packages. Package
scripts are disabled for this install check. It removes `node_modules` and runs
a frozen offline install from the generated lockfile. It then checks the installed
package names and versions. This is a package install check, not an app smoke test.

Only after these checks pass does the workflow publish the GitHub Release.
Thus `release.published` means the complete package set passed verification.
GitHub and npm use the same CI tarballs. The manifest is a GitHub asset, not an
npm package. Consumers must pin the manifest or its hash rather than trusting a
fresh manifest on each deployment.

### Retry and rollout

If verification fails, the release stays in draft. Fix the cause, then run
`Publish GitHub release` with the same tag. A retry uploads only missing assets
and checks existing bytes. It never replaces assets. If an existing asset has
wrong bytes or an unfinished upload, stop for manual review. Do not overwrite a
published release. A retry of a complete published release only verifies it.

Actions artifacts remain available for 30 days. GitHub Release assets are the
durable package source. If the CI artifact expires before publication, stop for
manual review; do not silently rebuild the same release version.

The workflow and Craft configuration must reach the default branch before the
first release that uses this path. That release must pass the new CI packaging
checks. Older releases have no manifest and are not changed by this workflow.
Keep `junior-prod` on its current install path until its separate update and
install scripts can use a verified release.

## Docs deployment

Docs are deployed at `https://junior.sentry.dev/` from `packages/docs`.

Recommended preflight:

```bash
pnpm release:check
pnpm docs:check
```

## Next step

After release, run smoke checks from [Verify & Troubleshoot](/start-here/verify-and-troubleshoot/) and monitor with [Observability](/operate/observability/).
