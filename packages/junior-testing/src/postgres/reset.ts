import type pg from "pg";

const TEST_DATABASE_RESET_LOCK_ID = 287442;
const SCHEMA_NAME = "public";

export interface ResetPostgresTestDatabaseOptions {
  /** Add rows that migrations seed again, in the reset transaction. */
  afterTruncate?(client: pg.PoolClient): Promise<void>;
}

function isRetryableResetError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "40P01" || error.code === "55P03")
  );
}

async function truncateTables(
  client: pg.PoolClient,
  options: ResetPostgresTestDatabaseOptions,
): Promise<void> {
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
      [SCHEMA_NAME],
    );
    const tableNames = tableRows.rows.map((row) => row.qualified_name);
    if (tableNames.length > 0) {
      await client.query(`TRUNCATE TABLE ${tableNames.join(", ")} CASCADE`);
      await options.afterTruncate?.(client);
    }

    const sequenceRows = await client.query<{ qualified_name: string }>(
      `
SELECT format('%I.%I', sequence_schema, sequence_name) AS qualified_name
FROM information_schema.sequences
WHERE sequence_schema = $1
ORDER BY sequence_name ASC
`,
      [SCHEMA_NAME],
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

/** Empty every table in a worker database and restart its sequences. */
export async function resetPostgresTestDatabase(
  pool: pg.Pool,
  options: ResetPostgresTestDatabaseOptions = {},
): Promise<void> {
  const client = await pool.connect();
  try {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await truncateTables(client, options);
        return;
      } catch (error) {
        if (attempt >= 2 || !isRetryableResetError(error)) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
      }
    }
  } finally {
    client.release();
  }
}
