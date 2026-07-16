# `@sentry/junior-migrations`

Junior's migration format extends a Drizzle Kit journal with TypeScript data
migrations. Every journal entry resolves to exactly one `<tag>.sql` or
`<tag>.ts` file. Drizzle Kit continues to own numbering and schema snapshots;
the Junior migration runner owns execution and exact per-entry tracking.

TypeScript migrations target a versioned capability API and must not import
Junior runtime internals. Migration-specific parsers and transforms belong
permanently in the migration file so application refactors or deletions cannot
break pending upgrades.

## Authoring

Generate schema migrations with the owning package's normal Drizzle command.
Generate data migrations through this package's wrapper:

```bash
junior-migrations generate \
  --config drizzle.config.ts \
  --out migrations \
  --name backfill_actor
```

The wrapper asks Drizzle Kit to create a custom journal entry, replaces the
empty SQL file with a `MigrationV1` TypeScript scaffold, and removes the
unchanged custom snapshot. Schema generation continues from the latest real
schema snapshot while preserving the mixed journal order.

## Compatibility

Drizzle Kit remains the supported authoring tool. Drizzle ORM's stock
`migrate()` function is not a supported executor for mixed journals because it
requires every entry to have a SQL file. Call `runMigrationJournal` instead and
provide the host database adapter, state adapter, and TypeScript loader. The
same database adapter drives the journal ledger and is exposed as
`context.database`, so migration files never own connection or driver setup.

The runner rejects runtime imports of application source, relative modules,
and unversioned `@sentry/junior` modules. Migrations may import the append-only
`@sentry/junior/migration-helpers/v1` surface for parsing primitives, adapters,
stores, and key resolution. One-off migration decisions and data transforms
must still remain in the journal entry. Add a new helper or capability version
rather than changing an existing contract.
