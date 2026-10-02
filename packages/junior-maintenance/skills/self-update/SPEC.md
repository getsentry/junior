# Self-update

## Intent and scope

Update junior-prod from verified GitHub Release packages without waiting for npm.
The skill owns release selection, release-note review, app checks, and a draft PR.
The consumer app owns artifact validation and file changes through its update script. pnpm owns downloads, caching, and integrity checks on install.
Release publication, production deployment, and source previews are out of scope.

## Shape and evidence

Keep one inline workflow. Do not duplicate the app's deterministic package checks
in skill instructions or bundle another copy of its scripts.

Authoritative sources are the app's pinned manifest and update script,
GitHub release bodies, and example-app source at the manifest commits.
The release manifest contract is documented in
`packages/docs/src/content/docs/contribute/releasing.md`.
The rollout is tracked in getsentry/junior#1934.

## Validation

Requests such as “self-update” or “update Junior to 0.227.0” should load this skill.
Requests to publish Junior, edit core runtime code, or preview a source branch
should not. Check that a missing manifest, bad hash, or missing app script stops
the update rather than selecting npm. Run `pnpm skills:check` after edits.

## Limits and maintenance

The app must first adopt the GitHub release install path. Older app versions stop
with that requirement. The updated skill reaches installed apps through the next
junior-maintenance release; changing this source does not update an installed skill.
Keep the skill commands aligned with the consumer scripts when their interface
changes. Do not store credentials or customer data in skill artifacts.
