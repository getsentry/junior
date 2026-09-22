# SQL migrations

`src/db/schema.ts` is the Drizzle schema entrypoint. This directory is the
append-only history used to bring an existing database to that schema.

`junior upgrade` applies core migrations and enabled plugins' packaged Drizzle
migrations. Core SQL is recorded in `drizzle.__drizzle_junior_core`. Reruns
check that journal before taking the migration lock, so an already-current
schema returns without opening a second SQL connection.

Core migrations need the `vector` (pgvector) and `btree_gin` Postgres
extensions. `junior upgrade` enables them under the migration lock. It stops
with a prerequisite error when the database cannot enable either one.

An existing Junior schema without the core Drizzle journal cannot be upgraded
directly. Upgrade it with `@sentry/junior@0.107.1` first so that bridge release
can establish the journal, then continue to the target version. A database with
no Junior tables remains a normal fresh install.

## Add a migration

1. Change the owning table definition under `src/db/schema/`.
2. Run `pnpm --filter @sentry/junior db:generate --name <migration_name>`.
3. Review the generated SQL and commit it with `meta/_journal.json` and its
   snapshot.

- Put deterministic row transformations in the SQL migration that requires
  them.
- Never edit, rename, reorder, or delete an applied SQL migration or its
  metadata. Add a new migration to correct it.

## Memory adoption

`0045_memory_core` adopts the Memory tables that the `@sentry/junior-memory`
plugin used to own. It creates the final schema on a fresh database and
reconciles an existing database from any legacy plugin journal position,
applying only the transitions and data rewrites that are still missing. The
legacy plugin journal stays in the database as audit state. Rehearse the
upgrade against real Postgres with:

```bash
DATABASE_URL=postgres://junior:junior@localhost:54322/junior \
  pnpm --filter @sentry/junior exec tsx scripts/rehearse-memory-upgrade.ts
```

Migration loading, locking, the extension check, and the bridge-version guard
live in `src/chat/conversations/sql/migrations.ts`. Their integration coverage
lives in `tests/integration/conversation-sql.test.ts`.
