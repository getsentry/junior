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
const originalDatabaseUrl = process.env.DATABASE_URL;
const originalJuniorDatabaseDriver = process.env.JUNIOR_DATABASE_DRIVER;
let resetPool: pg.Pool | undefined;

function assertLocalDatabaseUrl(databaseUrl: string): void {
  const { hostname } = new URL(databaseUrl);
  if (hostname !== "localhost" && hostname !== "127.0.0.1") {
    throw new Error(
      `Junior test database URL must point at localhost or 127.0.0.1, got ${hostname}`,
    );
  }
}

if (harnessConfig) {
  const databaseUrl = await getPostgresWorkerDatabaseUrl(
    parsePostgresHarnessConfig(harnessConfig),
  );
  assertLocalDatabaseUrl(databaseUrl);
  process.env.DATABASE_URL = databaseUrl;
  process.env.JUNIOR_DATABASE_DRIVER = "postgres";
  resetPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
  });
}

function isRetryableResetError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "40P01" || error.code === "55P03")
  );
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

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function resetPostgresTestDatabaseWithRetry(
  client: pg.PoolClient,
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await resetPostgresTestDatabase(client);
      return;
    } catch (error) {
      if (attempt >= 2 || !isRetryableResetError(error)) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
}

beforeEach(async () => {
  if (!resetPool) {
    return;
  }
  const client = await resetPool.connect();
  try {
    await resetPostgresTestDatabaseWithRetry(client);
  } finally {
    client.release();
  }
});

afterAll(async () => {
  await resetPool?.end();
  if (originalDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = originalDatabaseUrl;
  }
  if (originalJuniorDatabaseDriver === undefined) {
    delete process.env.JUNIOR_DATABASE_DRIVER;
  } else {
    process.env.JUNIOR_DATABASE_DRIVER = originalJuniorDatabaseDriver;
  }
  await cleanupPostgresWorkerDatabases();
});
