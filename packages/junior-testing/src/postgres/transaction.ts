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
  return {
    connectionString,
    databaseName,
    pool: new Pool({
      application_name: config.applicationName,
      connectionString,
      max: 4,
    }),
  };
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
