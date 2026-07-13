# `@sentry/junior-migrations`

Junior's migration format extends a Drizzle Kit journal with TypeScript data
migrations. Every journal entry resolves to exactly one `<tag>.sql` or
`<tag>.ts` file. Drizzle Kit continues to own numbering and schema snapshots;
the Junior migration runner owns execution and exact per-entry tracking.

TypeScript migrations target a versioned capability API and must not import
Junior runtime internals. New parsers and transforms belong in the migration
file so application refactors cannot break pending upgrades. A journal can
also invoke a versioned host task when adopting legacy migration code that
already shipped before the mixed journal existed; the task name then becomes
part of the permanent migration ABI.

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
provide the SQL, state, loader, and locking capabilities owned by the host.

The runner validates that each TypeScript migration has no runtime imports.
Only a type-only import from `@sentry/junior-migrations` is accepted. Add a new
API version rather than changing an existing migration capability contract.
