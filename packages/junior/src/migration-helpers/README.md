# Migration Helpers

This directory owns versioned, append-only infrastructure helpers available to
packaged TypeScript migrations through `@sentry/junior/migration-helpers/v1`.

Helpers may expose stable parsing primitives and other reusable infrastructure.
They must not contain one-off migration decisions or data transforms. Logic
such as mapping one retired record shape into another belongs only in the
journal entry that performs that migration.

The behavior and signature of an existing version are permanent compatibility
contracts. Add a new versioned entrypoint when that contract must change.
Migration files may be updated while still unreleased, but shipped migration
sources are hash-verified ledger entries and must remain immutable.
