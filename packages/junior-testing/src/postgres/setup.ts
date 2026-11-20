/**
 * Vitest setup file that pairs with `@sentry/junior-testing/postgres/global-setup`.
 * It empties the worker database before each test.
 */
import pg from "pg";
import { afterAll, beforeEach } from "vitest";
import { getPostgresTestDatabaseUrl } from "./worker";
import { resetPostgresTestDatabase } from "./reset";
import { cleanupPostgresWorkerDatabases } from "./transaction";

const resetPool = new pg.Pool({
  connectionString: await getPostgresTestDatabaseUrl(),
  max: 1,
});

beforeEach(async () => {
  await resetPostgresTestDatabase(resetPool);
});

afterAll(async () => {
  await resetPool.end();
  await cleanupPostgresWorkerDatabases();
});
