# SQL Migrations

`src/db/schema.ts` is the Drizzle schema entry point. This directory is the
append-only history that brings an existing database to that schema.
`src/chat/conversations/sql/migrations.ts` owns loading, locking, and the
bridge-version guard.

## Rules

- Never edit, rename, reorder, or delete an applied migration or its
  metadata. Add a new migration to correct it.
- Change the table under `src/db/schema/`, then run
  `pnpm --filter @sentry/junior db:generate --name <name>`. Commit the SQL,
  `meta/_journal.json`, and the snapshot together.
- Put fixed row transformations in the migration that needs them.
- A schema without the core Drizzle journal must first upgrade through
  `@sentry/junior@0.107.1`. Do not remove that guard.
