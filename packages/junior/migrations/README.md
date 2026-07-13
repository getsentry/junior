# SQL migrations

`src/db/schema.ts` is the Drizzle schema entrypoint. This directory is the
append-only history used to bring an existing database to that schema. It
extends Drizzle Kit's journal with self-contained
TypeScript data migrations. Drizzle Kit owns numbering, snapshots, and journal
entries; `junior upgrade` executes each entry as either `<tag>.sql` or
`<tag>.ts` through `@sentry/junior-migrations`.

`junior upgrade` runs the ordered migration list in `src/cli/upgrade.ts`. Core
SQL runs under a migration lock and is recorded in
`drizzle.__drizzle_junior_core`, so reruns do not reapply it. Register backfills
after the schema migration they require.

## Add a migration

1. Change the owning table definition under `src/db/schema/`.
2. Run `pnpm --filter @sentry/junior db:generate --name <migration_name>`.
3. Review the generated SQL and commit it with `meta/_journal.json` and its
   snapshot.

- Prefer SQL for schema changes and deterministic transformations of rows in
  the same database.
- Use an application data migration only for external data or work that must be
  decoded in application code; keep it bounded and rerunnable.
- Never edit, rename, reorder, or delete an applied SQL migration or its
  metadata. Add a new migration to correct it.

For a data migration, run
`pnpm --filter @sentry/junior db:generate:data --name <migration_name>`.
TypeScript migrations target the versioned migration capability API and must
not import Junior runtime internals or current feature schemas. Their complete
implementation remains in the migration file and uses only the stable SQL,
state, Redis, and progress capabilities supplied by the runner.

The `0000_initial.sql` baseline represents the schema already deployed by the
pre-Drizzle Junior migration runner. During upgrade, existing installations
adopt that baseline once; new installations execute it normally. All later
migrations are applied by Junior in journal order. Drizzle ORM's stock
`migrate()` function is not compatible with TypeScript entries in this folder.

Migration loading, locking, and legacy baseline adoption live in
`src/chat/conversations/sql/migrations.ts`. Their integration coverage lives in
`tests/integration/conversation-sql.test.ts`.
