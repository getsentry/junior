import pg from "pg";
import { afterAll, beforeEach, inject } from "vitest";
import {
  cleanupPostgresWorkerDatabases,
  getPostgresWorkerDatabaseUrl,
  parsePostgresHarnessConfig,
} from "@sentry/junior-testing/postgres";

const { Pool } = pg;
const TEST_DATABASE_RESET_LOCK_ID = 287442;
const schemaName = "public";
const harnessConfig = inject("juniorPostgresHarness");
const originalJuniorDatabaseDriver = process.env.JUNIOR_DATABASE_DRIVER;
let resetPool: pg.Pool | undefined;

if (harnessConfig) {
  process.env.JUNIOR_DATABASE_URL = await getPostgresWorkerDatabaseUrl(
    parsePostgresHarnessConfig(harnessConfig),
  );
  process.env.JUNIOR_DATABASE_DRIVER = "postgres";
  resetPool = new Pool({
    connectionString: process.env.JUNIOR_DATABASE_URL,
    max: 1,
  });
}

async function resetPostgresTestDatabase(client: pg.PoolClient): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query("SELECT pg_advisory_xact_lock($1)", [
      TEST_DATABASE_RESET_LOCK_ID,
    ]);
    const tableRows = await client.query<{ qualified_name: string }>(
      `
SELECT format('%I.%I', schemaname, tablename) AS qualified_name
FROM pg_tables
WHERE schemaname = $1
  AND tablename <> 'junior_schema_migrations'
ORDER BY tablename ASC
`,
      [schemaName],
    );
    const tableNames = tableRows.rows.map((row) => row.qualified_name);
    if (tableNames.length > 0) {
      await client.query(`TRUNCATE TABLE ${tableNames.join(", ")} CASCADE`);
    }

    const sequenceRows = await client.query<{ qualified_name: string }>(
      `
SELECT format('%I.%I', sequence_schema, sequence_name) AS qualified_name
FROM information_schema.sequences
WHERE sequence_schema = $1
ORDER BY sequence_name ASC
`,
      [schemaName],
    );
    for (const { qualified_name: sequenceName } of sequenceRows.rows) {
      await client.query(`ALTER SEQUENCE ${sequenceName} RESTART WITH 1`);
    }

    await client.query(
      "DELETE FROM junior_schema_migrations WHERE id LIKE 'plugin:%'",
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

beforeEach(async () => {
  if (!resetPool) {
    return;
  }
  const client = await resetPool.connect();
  try {
    await resetPostgresTestDatabase(client);
  } finally {
    client.release();
  }
});

afterAll(async () => {
  await resetPool?.end();
  if (originalJuniorDatabaseDriver === undefined) {
    delete process.env.JUNIOR_DATABASE_DRIVER;
  } else {
    process.env.JUNIOR_DATABASE_DRIVER = originalJuniorDatabaseDriver;
  }
  await cleanupPostgresWorkerDatabases();
});
