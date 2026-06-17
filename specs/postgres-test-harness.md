# Postgres Test Harness

## Metadata

- Created: 2026-06-17
- Last Edited: 2026-06-17

## Purpose

Junior SQL tests should exercise real Postgres behavior without paying schema
setup cost in every test. The harness provides a reusable migrated database
template plus per-test transaction rollback.

## Scope

This spec covers Vitest tests that need Postgres-backed storage, migrations, or
SQL executor behavior. It does not replace unit tests, evals, Slack HTTP
contract tests, or tests whose contract is independent of Postgres behavior.

## Non-Goals

- Do not replace PGlite fixtures where Postgres-compatible in-memory behavior is
  sufficient.
- Do not require a local Postgres service for ordinary package test runs.
- Do not disable Vitest file parallelism as the default isolation strategy.
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

The harness is opt-in outside CI. `JUNIOR_TEST_DATABASE_URL` enables global
Postgres setup; when it is unset, Postgres-harness-specific tests must skip and
the existing PGlite-backed tests continue to run. CI provides
`JUNIOR_TEST_DATABASE_URL` through the workflow Postgres service so the harness
contract is still exercised on pull requests.

Global setup creates a run-scoped database prefix from the test process and a
random suffix. It creates a migrated template database once per Vitest run, then
stores serializable connection details for workers.

Worker databases are created from the migrated template. Each worker uses a
database name derived from `VITEST_POOL_ID` so test files can remain parallel.

The harness must terminate only connections with the configured test
application name before dropping or recreating test databases.

## Fixture Modes

`createMigratedJuniorSqlFixture()` is the default SQL fixture. It uses a
worker-scoped database cloned from the migrated template, checks out one client,
starts `BEGIN`, and rolls back in `close()`.

`createEmptyJuniorSqlFixture()` is for migration contract tests. It creates an
empty isolated database and does not apply Junior migrations implicitly.

## Transaction Contract

Transactional fixtures pin all SQL calls to one `pg.Client`.

`executor.transaction()` inside a transactional fixture must use savepoints, not
commit the outer test transaction. Nested transactions create nested savepoints.
Failed nested transactions roll back to their savepoint and release it from the
fixture's stack before rethrowing.

`withLock()` may use Postgres advisory transaction locks inside the current
transaction. Empty lock names are invalid.

Tests that use transactional fixtures must inject the returned executor or a
store built from it. Production singleton database construction is not eligible
for rollback isolation.

Calling `executor.close()` on a transactional fixture must be equivalent to
calling the fixture's `close()`: rollback happens once, the client is released
once, and repeated close calls are no-ops.

## Migration Contract

Template setup may run Junior core migrations once. Tests using migrated
fixtures must not assert first-run migration side effects.

Migration tests must use empty fixtures and explicitly call the migration
function under test.

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
- Transactional fixture state must never commit to the worker database.

## Observability

The harness does not define product telemetry. Test failures should surface as
Vitest failures from setup, fixture creation, migration, rollback, or cleanup.

## Validation

Harness changes should include:

- one isolation test proving data from one transactional fixture is rolled back
  before the next fixture;
- one migrated fixture test proving core schema is already present;
- one empty fixture test proving migrations are explicit;
- targeted converted SQL store tests;
- `pnpm --filter @sentry/junior-testing typecheck`;
- `pnpm --filter @sentry/junior typecheck`.

## Related Specs

- `testing.md`
- `component-testing.md`
- `integration-testing.md`
- `conversation-storage.md`
- `plugin-database.md`
