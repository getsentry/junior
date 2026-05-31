# Backfill Release Packaging Specs

## Why

Junior publishes multiple npm packages in lockstep. Release packaging spans package metadata, Craft targets, version bump scripts, CI pack artifacts, README package lists, contributing docs, and public release docs. The repo already has a `release:check` script to keep those lists aligned, but the behavior is not specified as an OpenSpec capability.

The baseline needs to make publishable-package ownership and release-list drift rules explicit.

## What Changes

- Add a `release-packaging` spec for:
  - publishable package inventory;
  - lockstep version bumping;
  - Craft target alignment;
  - CI artifact packing/uploading;
  - release-list drift checks;
  - docs/README alignment;
  - package artifact boundary expectations;
  - verification expectations and open questions.

## Out of Scope

- Running a release.
- Changing package versions.
- Defining provider package runtime behavior already owned by `provider-packages`.
- Defining docs content quality already owned by `docs-site`.

## Impact

Adding, removing, or renaming a publishable package will have an explicit checklist and validation command. Release drift should be caught before publish artifacts are produced.
