---
title: Database Migrations
description: Generate and review Junior schema and data migrations.
type: tutorial
summary: Choose the right migration type, generate it in the owning package, and verify the result.
prerequisites:
  - /contribute/development/
related:
  - /cli/upgrade/
  - /contribute/testing/
  - /contribute/releasing/
---

Junior keeps schema and data migrations in the same ordered Drizzle journal.
Each journal entry has exactly one source file:

| Change                                                                        | Generate         | Result                              |
| ----------------------------------------------------------------------------- | ---------------- | ----------------------------------- |
| Tables, columns, indexes, or a simple SQL backfill                            | Schema migration | `<tag>.sql` plus a Drizzle snapshot |
| Data that needs application code, state storage, Redis, or resumable progress | Data migration   | `<tag>.ts` with no new snapshot     |

Generate the migration in the package that owns the schema. Core Junior uses
`@sentry/junior`; plugin tables use their plugin package.

## Generate a schema migration

First change the owning Drizzle schema, such as
`packages/junior/src/db/schema.ts`. Then run:

```bash
pnpm --filter @sentry/junior db:generate --name add_delivery_status
```

For a plugin, replace the package name:

```bash
pnpm --filter @sentry/junior-memory db:generate --name add_memory_source
```

Drizzle adds a SQL file, updates `meta/_journal.json`, and writes a schema
snapshot. The generated SQL looks like:

```sql title="migrations/0007_add_delivery_status.sql"
ALTER TABLE "junior_conversations"
ADD COLUMN "delivery_status" text;
```

Review the SQL against the schema change. Prefer SQL when the work is entirely
inside the same database and does not need application-level decoding.

## Generate a data migration

Use a data migration when SQL is not enough—for example, when moving data from
state storage, preserving a Redis index, decoding an old application record, or
checkpointing a long backfill.

```bash
pnpm --filter @sentry/junior db:generate:data --name backfill_delivery_status
```

The command adds a TypeScript entry to the same journal:

```ts title="migrations/0008_backfill_delivery_status.ts"
import type { MigrationV1 } from "@sentry/junior-migrations";

const migration = {
  apiVersion: 1,
  async up(context) {
    void context;
  },
} satisfies MigrationV1;

export default migration;
```

Implement `up` with the capabilities on `context`:

- `database` for queries, transactions, and database locks
- `state` for Junior or plugin-scoped state
- `redis` when a migration must preserve raw Redis structures
- `progress` for a checkpoint that survives a failed or interrupted run
- `log` for operator-facing progress messages

Keep one-off decoding and transformation logic in the migration file. Do not
import current Junior runtime modules from a data migration.

## Review and verify

Before committing:

1. Confirm the new journal entry has exactly one `.sql` or `.ts` file.
2. Commit the updated `meta/_journal.json`.
3. Commit the new snapshot for a schema migration; a data migration should not
   add one.
4. Do not edit, rename, reorder, or delete a migration that has shipped.
5. Make long-running data migrations safe to retry and use `progress` when
   partial work must resume.

Run the focused migration checks:

```bash
pnpm --filter @sentry/junior-migrations test
pnpm typecheck
```

`junior upgrade` runs schema and data entries in journal order. Schema-bootstrap
mode is only for constructing empty test databases; it is not an upgrade path
for an existing installation.

## Next step

Add focused coverage using the guidance in [Testing](/contribute/testing/),
then review the release path in [Releasing](/contribute/releasing/).
