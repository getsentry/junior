/**
 * Generic Postgres test harness surface.
 *
 * This package owns database lifecycle, reset, and transaction isolation.
 * Product schema, migrations, and Drizzle adapters belong in package-local
 * fixtures.
 */
export {
  assertLocalPostgresUrl,
  parsePostgresHarnessConfig,
  type PostgresHarnessConfig,
} from "./config";
export { resetPostgresTestDatabase } from "./reset";
export {
  cleanupPostgresHarness,
  setupPostgresTemplate,
  type SetupPostgresTemplateOptions,
} from "./template";
export {
  cleanupPostgresWorkerDatabases,
  createEmptyPostgresDatabase,
  createPostgresTransactionFixture,
  getPostgresWorkerDatabaseUrl,
  type PostgresIsolatedDatabase,
  type PostgresTransactionFixture,
} from "./transaction";
