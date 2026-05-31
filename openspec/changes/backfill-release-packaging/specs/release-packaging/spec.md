## ADDED Requirements

### Requirement: Publishable Package Inventory

Junior SHALL derive the public release inventory from package manifests under `packages/`.

#### Scenario: Package is publishable

- **WHEN** a `packages/*/package.json` file has `private` absent or `private: false`
- **THEN** the package SHALL be part of the lockstep public release inventory
- **AND** it SHALL have a non-empty package `name`
- **AND** it SHALL be represented in release tooling and package inventory docs

#### Scenario: Package is private

- **WHEN** a `packages/*/package.json` file has `private: true`
- **THEN** the package SHALL NOT be included in public npm release targets
- **AND** it SHALL NOT be required in lockstep release package lists

#### Scenario: Public package is scoped

- **WHEN** a public package uses the `@sentry` scope
- **THEN** its package metadata SHALL include publish configuration required for public npm access

### Requirement: Lockstep Version Bumping

Junior public packages SHALL be versioned in lockstep by the release preparation flow.

#### Scenario: Craft pre-release command runs

- **WHEN** Craft runs the configured pre-release command with old and new versions
- **THEN** the command SHALL invoke the repository version bump script with the new version
- **AND** every publishable package in the release inventory SHALL have its package `version` updated to that new version

#### Scenario: Version bump command is missing a version

- **WHEN** the version bump script is run without a new version argument
- **THEN** it SHALL print usage and fail non-zero

### Requirement: Release List Alignment

Junior SHALL keep release-driving and package-inventory lists aligned with publishable package manifests.

#### Scenario: Release check runs

- **WHEN** `pnpm release:check` runs
- **THEN** it SHALL derive expected packages from non-private `packages/*/package.json` files
- **AND** it SHALL compare that expected list to `.craft.yml`, the version bump script, CI pack commands, README package inventory, contributing release docs, and public release docs

#### Scenario: Package list mismatch exists

- **WHEN** any checked release-list source is missing a publishable package or includes an extra package
- **THEN** `pnpm release:check` SHALL fail non-zero
- **AND** it SHALL report the source label plus missing and extra package names

#### Scenario: Package lists are aligned

- **WHEN** all checked sources match the publishable package inventory
- **THEN** `pnpm release:check` SHALL succeed
- **AND** it SHALL print the count of aligned publishable packages and checked sources

### Requirement: Craft Release Targets

Junior SHALL configure Craft npm targets for every publishable package.

#### Scenario: Craft target is configured

- **WHEN** a package is publishable
- **THEN** `.craft.yml` SHALL include an npm target whose `id` is the package name
- **AND** the target SHALL include an artifact-name filter matching the tarball generated for that package

#### Scenario: Craft publishes artifacts

- **WHEN** Craft publishes a prepared release
- **THEN** it SHALL publish only artifacts matching configured npm targets and include filters

### Requirement: CI Pack Artifacts

Junior CI SHALL produce package tarballs for publishable packages on push builds.

#### Scenario: Push CI packs artifacts

- **WHEN** CI runs for a push event
- **THEN** it SHALL create an artifact directory
- **AND** it SHALL run package pack commands for every publishable package
- **AND** it SHALL upload `*.tgz` artifacts with a failure mode that errors when no files are found
- **AND** artifact retention SHALL be bounded

#### Scenario: Pull request CI runs

- **WHEN** CI runs for a pull request
- **THEN** it SHALL still run `pnpm release:check`
- **AND** it MAY skip uploading release pack artifacts

### Requirement: Package Artifact Metadata

Public package manifests SHALL describe the package artifact surface accurately.

#### Scenario: Package has runtime exports or binaries

- **WHEN** a public package exposes runtime imports or a binary
- **THEN** its package metadata SHALL declare the relevant `exports` or `bin` fields
- **AND** its `files` list SHALL include the built files required by that public surface

#### Scenario: Package contains plugin content

- **WHEN** a public provider/plugin package ships plugin manifests or skills
- **THEN** its `files` list SHALL include the plugin content needed by configured package discovery
- **AND** provider-specific runtime behavior SHALL be governed by `provider-packages`, `plugin-manifest`, and `plugin-runtime`

### Requirement: Release Documentation

Release documentation SHALL match the lockstep release inventory and workflow.

#### Scenario: Package inventory docs change

- **WHEN** README, contributing docs, or public release docs list release packages
- **THEN** those lists SHALL match the publishable package inventory
- **AND** `pnpm release:check` SHALL be run after list changes

#### Scenario: Release workflow docs change

- **WHEN** docs describe how to trigger a release
- **THEN** they SHALL identify the manual GitHub Actions release workflow, bump choices, force behavior, and required credentials at the level users need to operate the release

### Requirement: Release Packaging Verification

Release packaging changes SHALL be verified before they are considered complete.

#### Scenario: Publishable package added, removed, renamed, or privatized

- **WHEN** package publishability or package name changes
- **THEN** `.craft.yml`, CI pack commands, version bump script, README, contributing docs, and public release docs SHALL be aligned
- **AND** `pnpm release:check` SHALL pass

#### Scenario: Package public artifact surface changes

- **WHEN** package `files`, `exports`, `bin`, build output, plugin content, or trusted hook entrypoints change
- **THEN** package build/pack verification SHALL cover the changed artifact surface
- **AND** missing tarball-content checks SHALL be recorded as a release-packaging verification gap

#### Scenario: Release workflow changes

- **WHEN** `.github/workflows/release.yml`, `.craft.yml`, or release scripts change
- **THEN** `pnpm release:check` SHALL pass
- **AND** the change SHALL be reviewed against Craft and GitHub Actions release assumptions
