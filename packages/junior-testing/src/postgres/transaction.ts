import { randomUUID } from "node:crypto";
import pg, { type PoolClient } from "pg";
import {
  createEmptyPostgresTestDatabase,
  createPostgresTestDatabaseFromTemplate,
  dropPostgresTestDatabase,
} from "./admin";
import type { PostgresHarnessConfig } from "./config";

const { Pool } = pg;

declare global {
  // Vitest can re-evaluate setup modules inside a worker. Cache the worker
  // database promise on globalThis so one worker owns one cloned database.
  // eslint-disable-next-line no-var
  var __juniorPostgresWorkerDatabases:
    | Map<string, Promise<PostgresWorkerDatabase>>
    | undefined;
}

export interface PostgresTransactionFixture<TResource> {
  connectionString: string;
  resource: TResource;
  close(): Promise<void>;
}

export interface PostgresIsolatedDatabase {
  connectionString: string;
  databaseName: string;
  close(): Promise<void>;
}

interface PostgresWorkerDatabase {
  connectionString: string;
  databaseName: string;
  pool: pg.Pool;
}

function workerId(): string {
  return (process.env.VITEST_POOL_ID ?? "0").replace(/[^a-zA-Z0-9_]/g, "_");
}

function randomName(prefix: string, label: string): string {
  return `${prefix}_${label}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

async function createWorkerDatabase(
  config: PostgresHarnessConfig,
): Promise<PostgresWorkerDatabase> {
  const databaseName = `${config.databasePrefix}_w${workerId()}`;
  const connectionString = await createPostgresTestDatabaseFromTemplate(
    config,
    databaseName,
    config.templateDatabaseName,
  );
  const pool = new Pool({
    application_name: config.applicationName,
    connectionString,
    max: 4,
  });
  // Template cloning can terminate idle clients. The pool replaces them; an
  // unhandled pool error would crash the Vitest worker instead.
  pool.on("error", (error) => {
    console.warn(`Postgres test pool client failed: ${error.message}`);
  });
  return { connectionString, databaseName, pool };
}

/** Return the current Vitest worker's cloned migrated database. */
async function getPostgresWorkerDatabase(
  config: PostgresHarnessConfig,
): Promise<PostgresWorkerDatabase> {
  globalThis.__juniorPostgresWorkerDatabases ??= new Map();
  const key = `${config.databasePrefix}:${workerId()}`;
  let promise = globalThis.__juniorPostgresWorkerDatabases.get(key);
  if (!promise) {
    promise = createWorkerDatabase(config);
    globalThis.__juniorPostgresWorkerDatabases.set(key, promise);
  }
  return await promise;
}

/** Return the current Vitest worker's migrated database connection string. */
export async function getPostgresWorkerDatabaseUrl(
  config: PostgresHarnessConfig,
): Promise<string> {
  const workerDatabase = await getPostgresWorkerDatabase(config);
  return workerDatabase.connectionString;
}

const RESET_LOCK_ID = 287442;
// Product tables. Migration journals are in another schema and stay.
const SCHEMA = "public";

function isRetryableResetError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "40P01" || error.code === "55P03")
  );
}

async function reset(client: PoolClient): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query("SELECT pg_advisory_xact_lock($1)", [RESET_LOCK_ID]);
    const tables = await client.query<{ name: string }>(
      `
SELECT format('%I.%I', schemaname, tablename) AS name
FROM pg_tables
WHERE schemaname = $1
ORDER BY tablename ASC
`,
      [SCHEMA],
    );
    const names = tables.rows.map((row) => row.name);
    if (names.length > 0) {
      await client.query(`TRUNCATE TABLE ${names.join(", ")} CASCADE`);
    }

    const sequences = await client.query<{ name: string }>(
      `
SELECT format('%I.%I', sequence_schema, sequence_name) AS name
FROM information_schema.sequences
WHERE sequence_schema = $1
ORDER BY sequence_name ASC
`,
      [SCHEMA],
    );
    for (const { name } of sequences.rows) {
      await client.query(`ALTER SEQUENCE ${name} RESTART WITH 1`);
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

/**
 * Remove the rows that earlier tests left in the worker database, and restart
 * its sequences.
 */
export async function resetPostgresWorkerDatabase(
  config: PostgresHarnessConfig,
): Promise<void> {
  const { pool } = await getPostgresWorkerDatabase(config);
  const client = await pool.connect();
  try {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await reset(client);
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

/** Start a rollback-only transaction in the current worker database. */
export async function createPostgresTransactionFixture<TResource>(
  config: PostgresHarnessConfig,
  createResource: (args: {
    client: PoolClient;
    close: () => Promise<void>;
  }) => TResource,
): Promise<PostgresTransactionFixture<TResource>> {
  const workerDatabase = await getPostgresWorkerDatabase(config);
  const client = await workerDatabase.pool.connect();
  let open = true;
  await client.query("BEGIN");
  const close = async () => {
    if (!open) {
      return;
    }
    open = false;
    try {
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  };
  return {
    connectionString: workerDatabase.connectionString,
    resource: createResource({ client, close }),
    close,
  };
}

/** Close cached worker pools before global harness database cleanup. */
export async function cleanupPostgresWorkerDatabases(): Promise<void> {
  const databases = globalThis.__juniorPostgresWorkerDatabases;
  if (!databases) {
    return;
  }
  const pending = [...databases.values()];
  globalThis.__juniorPostgresWorkerDatabases = undefined;
  for (const database of pending) {
    const resolved = await database;
    await resolved.pool.end();
  }
}

/** Create a committed empty database for migration contract tests. */
export async function createEmptyPostgresDatabase(
  config: PostgresHarnessConfig,
  label = "empty",
): Promise<PostgresIsolatedDatabase> {
  const databaseName = randomName(config.databasePrefix, label);
  const connectionString = await createEmptyPostgresTestDatabase(
    config,
    databaseName,
  );
  return {
    connectionString,
    databaseName,
    close: async () => {
      await dropPostgresTestDatabase(config, databaseName);
    },
  };
}
