# SQL migrations for `@sentry/junior`

This directory is the ordered Drizzle migration history for Junior's core SQL
schema. The TypeScript schema under `src/db/schema/` is the current contract;
the SQL files and `meta/` records describe how an existing database reaches
that contract.

## Generate a migration

1. Change the owning schema under `src/db/schema/`.
2. Run
   `pnpm --filter @sentry/junior db:generate --name <migration_name>` from the
   repository root.
3. Review the generated SQL for locking, table rewrites, defaults, constraints,
   indexes, and compatibility with the currently deployed workers.
4. Commit the SQL file, `meta/_journal.json`, and generated snapshot together.

Drizzle compares the latest snapshot with the TypeScript schema. Snapshots are
generation inputs, not a substitute for the executable SQL history. Do not
rename, reorder, delete, or rewrite an applied migration, its snapshot, or its
journal entry; correct an already-shipped schema with a new migration.
Migration timestamps and journal order must remain append-only.

## Apply migrations

`junior upgrade` applies core schema migrations before running application data
backfills. `src/chat/conversations/sql/migrations.ts` resolves this packaged
directory in both source and built CLI layouts, serializes migration with the
core migration lock, and lets Drizzle record applied entries in
`drizzle.__drizzle_junior_core`. Re-running upgrade is expected and must not
reapply journaled SQL.

Schema migration and data migration are separate concerns:

- SQL files establish tables, columns, constraints, indexes, and temporary
  database compatibility objects.
- Upgrade migrations under `src/cli/upgrade/migrations/` perform bounded,
  rerunnable data adoption and backfills after the required schema exists.

Keep destructive or non-rolling cutovers explicit. If old and new workers
cannot safely share the intermediate schema, drain the incompatible workers,
apply the schema migration, run and verify the required backfill, and only then
start the new workers. The owning module README must document any active
cutover gate; migration filenames are not durable operational documentation.

## Legacy adoption

The initial Drizzle baseline represents schema that predated the Drizzle
journal. Upgrade may adopt that baseline only when the legacy migration records
and physical schema match the exact state recognized by
`migrations.ts`. Adoption validates historical checksums and requires complete,
internally consistent schema markers. Ambiguous, partial, or post-cutover state
fails closed for operator repair instead of inferring success from mutable
table shape.

This adoption path is the only exception to normal journal application. New
installations execute the baseline normally, and every later migration is
proved solely by the Drizzle journal.

## Verification invariants

- A migration must work on both a new database and every supported upgrade
  state.
- Running schema migration twice must be safe because the journal prevents a
  second application.
- Concurrent upgrade attempts must serialize on the migration lock.
- Generated SQL and metadata must stay synchronized with the schema change.
- Backfills must be bounded, rerunnable, and verify their completion criteria
  before an incompatible cutover proceeds.

The migration integration coverage in
`tests/integration/conversation-sql.test.ts` owns fresh-install, legacy-adoption,
ordering, locking, and failure-contract checks. Feature tests own the behavior
that becomes possible after a schema change.
