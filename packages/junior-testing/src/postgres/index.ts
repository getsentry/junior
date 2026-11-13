/**
 * Generic Postgres test harness surface.
 *
 * This package owns database lifecycle, reset, and transaction isolation.
 * A package with plain SQL files in `migrations/` uses the `global-setup`,
 * `setup`, and `fixture` entries instead. Product schema stays in the
 * package.
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
