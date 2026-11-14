import pg from "pg";
import { afterAll, beforeEach, inject } from "vitest";
import {
  assertLocalPostgresUrl,
  cleanupPostgresWorkerDatabases,
  getPostgresWorkerDatabaseUrl,
  parsePostgresHarnessConfig,
  resetPostgresTestDatabase,
} from "@sentry/junior-testing/postgres";

const { Pool } = pg;
const harnessConfig = inject("juniorPostgresHarness");
const originalDatabaseUrl = process.env["DATABASE_URL"];
const originalJuniorDatabaseDriver = process.env["JUNIOR_DATABASE_DRIVER"];
let resetPool: pg.Pool | undefined;

if (harnessConfig) {
  const databaseUrl = await getPostgresWorkerDatabaseUrl(
    parsePostgresHarnessConfig(harnessConfig),
  );
  assertLocalPostgresUrl(databaseUrl);
  process.env["DATABASE_URL"] = databaseUrl;
  process.env["JUNIOR_DATABASE_DRIVER"] = "postgres";
  resetPool = new Pool({
    connectionString: process.env["DATABASE_URL"],
    max: 1,
  });
  resetPool.on("error", (error) => {
    console.warn(`Postgres reset pool client failed: ${error.message}`);
  });
}

beforeEach(async () => {
  if (!resetPool) {
    return;
  }
  await resetPostgresTestDatabase(resetPool, {
    // Migration 0069 creates the system Identity. Truncation removes it, so
    // add it again like a migrated database has it.
    afterTruncate: async (client) => {
      await client.query(`
INSERT INTO "junior_identities" (
  "id", "kind", "provider", "provider_tenant_id", "provider_subject_id",
  "display_name", "created_at", "updated_at"
)
VALUES (
  'system', 'system', 'junior', '', 'system', 'System',
  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
)
`);
    },
  });
});

afterAll(async () => {
  await resetPool?.end();
  if (originalDatabaseUrl === undefined) {
    delete process.env["DATABASE_URL"];
  } else {
    process.env["DATABASE_URL"] = originalDatabaseUrl;
  }
  if (originalJuniorDatabaseDriver === undefined) {
    delete process.env["JUNIOR_DATABASE_DRIVER"];
  } else {
    process.env["JUNIOR_DATABASE_DRIVER"] = originalJuniorDatabaseDriver;
  }
  await cleanupPostgresWorkerDatabases();
});
