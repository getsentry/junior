# Migration Helpers

This directory owns versioned, append-only infrastructure helpers available to
packaged TypeScript migrations through `@sentry/junior/migration-helpers/v1`.

Helpers may expose stable parsing primitives, state/database adapters, stores,
and key resolution. They must not contain one-off migration decisions or data
transforms. Logic such as mapping one retired record shape into another belongs
only in the journal entry that performs that migration.

Never change the behavior or signature of an existing version in a way that can
break a pending migration. Add a new versioned entrypoint when the helper
contract must change.
