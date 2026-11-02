# SQL Migrations

Append-only history that brings a database to `src/db/schema.ts`.
`src/chat/conversations/sql/migrations.ts` owns loading, locking, and the
bridge-version guard.

- Never edit, rename, reorder, or delete an applied migration or its
  metadata. Add a new migration to correct it.
- Change the table under `src/db/schema/`, then run
  `pnpm --filter @sentry/junior db:generate --name <name>`. Commit the SQL,
  `meta/_journal.json`, and the snapshot together.
- Put fixed row transformations in the migration that needs them.
- A schema without the core Drizzle journal must first upgrade through
  `@sentry/junior@0.107.1`. Keep that guard.
