# `@sentry/junior-migrations`

Junior's migration format extends a Drizzle Kit journal with TypeScript data
migrations. Every journal entry resolves to exactly one `<tag>.sql` or
`<tag>.ts` file. Drizzle Kit continues to own numbering and schema snapshots;
the Junior migration runner owns execution and exact per-entry tracking.

TypeScript migrations target a versioned capability API and must not import
Junior runtime internals. Every parser, transform, and migration-specific
helper belongs permanently in the migration file so application refactors or
deletions cannot break pending upgrades.

## Authoring

Generate schema migrations with the owning package's normal Drizzle command.
Generate data migrations through this package's wrapper:

```bash
junior-migrations generate \
  --config drizzle.config.ts \
  --out migrations \
  --name backfill_actor
```

The wrapper asks Drizzle Kit to create a custom journal entry and snapshot,
then replaces the empty SQL file with a `MigrationV1` TypeScript scaffold.

## Compatibility

Drizzle Kit remains the supported authoring tool. Drizzle ORM's stock
`migrate()` function is not a supported executor for mixed journals because it
requires every entry to have a SQL file. Call `runMigrationJournal` instead and
provide the host database adapter, state adapter, and TypeScript loader. The
same database adapter drives the journal ledger and is exposed as
`context.database`, so migration files never own connection or driver setup.

The runner rejects runtime imports of application source, relative modules,
and `@sentry/junior`. External package imports are allowed when the migration
needs a stable library dependency; migration-specific implementation must
still remain in the migration file. Add a new API version rather than changing
an existing migration capability contract.
