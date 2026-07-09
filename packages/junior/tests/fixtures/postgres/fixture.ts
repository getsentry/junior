import { inject } from "vitest";
import {
  parsePostgresHarnessConfig,
  createEmptyPostgresDatabase,
  createPostgresTransactionFixture,
  type PostgresHarnessConfig,
} from "@sentry/junior-testing/postgres";
import type { JuniorSqlExecutor } from "@/db/db";
import {
  createClientJuniorSqlExecutor,
  createPooledJuniorSqlExecutor,
} from "./executor";

export interface JuniorPostgresFixture {
  sql: JuniorSqlExecutor;
  close(): Promise<void>;
}

export interface JuniorPostgresDatabaseFixture extends JuniorPostgresFixture {
  connectionString: string;
  databaseName: string;
}

/** Return whether the current Vitest run is configured for Postgres fixtures. */
export function hasJuniorPostgresTestDatabase(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

function getHarnessConfig(): PostgresHarnessConfig {
  const config = inject("juniorPostgresHarness");
  if (!config) {
    throw new Error(
      "DATABASE_URL is required for Junior Postgres test fixtures",
    );
  }
  return parsePostgresHarnessConfig(config);
}

/** Create a rollback-isolated fixture from the migrated Junior template DB. */
export async function createMigratedJuniorSqlFixture(): Promise<JuniorPostgresFixture> {
  const transaction = await createPostgresTransactionFixture(
    getHarnessConfig(),
    ({ client, close }) => createClientJuniorSqlExecutor(client, close),
  );
  return {
    sql: transaction.resource,
    close: () => transaction.close(),
  };
}

/** Create an empty committed database for migration contract tests. */
export async function createEmptyJuniorSqlFixture(): Promise<JuniorPostgresDatabaseFixture> {
  const config = getHarnessConfig();
  const database = await createEmptyPostgresDatabase(config);
  const pooled = createPooledJuniorSqlExecutor({
    applicationName: config.applicationName,
    connectionString: database.connectionString,
  });
  return {
    connectionString: database.connectionString,
    databaseName: database.databaseName,
    sql: pooled.db,
    close: async () => {
      await pooled.close();
      await database.close();
    },
  };
}
