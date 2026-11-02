# SQL Migrations

- Never edit, rename, reorder, or delete an applied migration or its
  metadata. Add a new migration to correct it.
- Put fixed row transformations in the migration that needs them.
- Keep the guard in `src/chat/conversations/sql/migrations.ts` that makes a
  schema without the core Drizzle journal upgrade through
  `@sentry/junior@0.107.1` first.
