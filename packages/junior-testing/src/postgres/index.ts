/**
 * Generic Postgres test harness surface.
 *
 * This package owns database lifecycle and transaction isolation only. Product
 * schema, migrations, and Drizzle adapters belong in package-local fixtures.
 */
export {
  parsePostgresHarnessConfig,
  type PostgresHarnessConfig,
} from "./config";
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
