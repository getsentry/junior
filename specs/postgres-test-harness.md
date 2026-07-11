# Postgres Test Harness

## Metadata

- Created: 2026-06-17
- Last Edited: 2026-06-17

## Purpose

Junior SQL tests should exercise real Postgres behavior without paying schema
setup cost in every test. The harness provides a migrated test database for
normal production-style imports plus explicit isolated fixtures for migration
contract tests.

## Scope

This spec covers Vitest tests that need Postgres-backed storage, migrations, or
SQL executor behavior. It does not replace unit tests, evals, Slack HTTP
contract tests, or tests whose contract is independent of Postgres behavior.

## Non-Goals

- Do not replace PGlite fixtures where Postgres-compatible in-memory behavior is
  sufficient.
- Do not require a local Postgres service for ordinary package test runs.
- Do not put Junior schema or Drizzle ownership into the generic
  `@sentry/junior-testing/postgres` package.

## Package Boundary

Generic Postgres and Vitest helpers live in `@sentry/junior-testing/postgres`.
They may depend on `pg` and Vitest-compatible setup contracts, but they must not
import Junior schema, migrations, Drizzle tables, runtime code, or plugin code.

Junior-specific adapters live under `packages/junior/tests/fixtures/postgres`.
They adapt generic clients to `JuniorSqlExecutor`, run Junior migrations, and
provide fixtures for Junior test files.

## Database Lifecycle

The harness uses Junior's normal SQL database configuration. Vitest and eval
configs load `apps/example/.env` as local defaults before workspace/package
overrides, so local tests use `postgres://junior:junior@localhost:54322/junior`
without per-command environment overrides. CI provides `DATABASE_URL` through
the workflow Postgres service, and explicit developer or CI env vars still take
precedence over env-file defaults.

Global setup creates a run-scoped database prefix from the test process and a
random suffix. It creates a migrated template database once per Vitest run, then
stores serializable connection details for workers.

Worker databases are created from the migrated template. Each worker uses a
database name derived from `VITEST_POOL_ID` so test files can remain parallel.

The harness must terminate only connections with the configured test
application name before dropping or recreating test databases.

Worker setup sets `DATABASE_URL` to the worker database URL before test files
import product modules. Tests that use normal Junior imports such as
configured conversation stores, plugin DB resolution, or `createJuniorSqlExecutor`
must therefore use the test database without changing import paths, injecting a
special executor, or mocking database factories.

Worker setup also sets `JUNIOR_DATABASE_DRIVER=postgres` while the harness is
active so local Postgres tests cannot inherit a Neon driver override from the
developer shell or CI environment.

The worker database URL must include the harness application name so production
code-created pools remain visible to harness cleanup.

Before each test, the worker setup resets product data in the worker database
under a Postgres advisory lock. Reset truncates public application tables,
restarts their identity/serial sequences, and preserves migration journals in
the `drizzle` schema because global setup already migrated the worker template.

## Fixture Modes

Normal integration and component tests should not need a SQL fixture to use the
test database. They should import product code normally and rely on
`DATABASE_URL` being pointed at the worker database by setup.

`createMigratedJuniorSqlFixture()` is for tests that specifically need a pinned
rollback-only transaction. It uses a worker-scoped database cloned from the
migrated template, checks out one client, starts `BEGIN`, and rolls back in
`close()`.

`createEmptyJuniorSqlFixture()` is for migration contract tests. It creates an
empty isolated database and does not apply Junior migrations implicitly.

## Transaction Contract

Transactional fixtures pin all SQL calls to one `pg.Client`.

`fixture.sql.transaction()` inside a transactional fixture must use savepoints, not
commit the outer test transaction. Nested transactions create nested savepoints.
Failed nested transactions roll back to their savepoint and release it from the
fixture's stack before rethrowing.

`withLock()` may use Postgres advisory transaction locks inside the current
transaction. Empty lock names are invalid.

Tests that use transactional fixtures must inject the returned `fixture.sql` or
a store built from it. Production singleton database construction uses the
worker-scoped global test database and before-each reset; it is not eligible for
transaction rollback isolation.

Closing a transactional fixture rolls back once, releases the client once, and
repeated close calls are no-ops.

## Migration Contract

Template setup may run Junior core migrations once. Tests using migrated
fixtures must not assert first-run migration side effects.

Migration tests must use empty fixtures and explicitly call the migration
function under test.

Plugin migrations in normal tests run against the worker database. Before-each
reset must remove plugin migration records so a plugin migration can be applied
fresh in a later test even if a previous test applied it.

Plugin migrations may run inside the per-test transaction unless a test
explicitly needs committed plugin schema state across clients.

## Vitest Contract

The harness should preserve file parallelism. Do not disable file parallelism as
the default isolation strategy.

Global setup passes only serializable values to workers. Live clients, pools,
and Drizzle database objects are created inside worker/test processes.

## Failure Model And Invariants

- Failed template migration drops the run-scoped harness databases before
  rethrowing.
- Database cleanup only terminates connections using the harness application
  name.
- Empty or isolated fixtures that open pooled connections must use the same
  harness application name as global cleanup.
- Product code-created test database pools must use the same harness application
  name through the generated worker database URL.
- Transactional fixture state must never commit to the worker database.
- Normal production-style imports must use the worker test database when
  `DATABASE_URL` is configured by the test/eval environment.

## Observability

The harness does not define product telemetry. Test failures should surface as
Vitest failures from setup, fixture creation, migration, rollback, or cleanup.

## Validation

Harness changes should include:

- representative product SQL suites run with `JUNIOR_TEST_DATABASE_URL` enabled,
  using normal product imports and existing test fixtures;
- at least one suite that exercises configured product database construction
  rather than an injected SQL executor;
- at least one suite that applies plugin migrations more than once across tests,
  proving before-each reset clears plugin migration state;
- migration contract tests that use empty fixtures and explicitly call the
  migration function under test;
- `pnpm --filter @sentry/junior-testing typecheck`;
- `pnpm --filter @sentry/junior typecheck`.

## Related Specs

- `testing.md`
- `component-testing.md`
- `integration-testing.md`
- `conversation-storage.md`
- `plugin-database.md`
