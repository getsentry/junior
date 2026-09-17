import { inject } from "vitest";
import {
  parsePostgresHarnessConfig,
  createEmptyPostgresDatabase,
  getPostgresWorkerDatabaseUrl,
  type PostgresHarnessConfig,
} from "@sentry/junior-testing/postgres";
import type { JuniorSqlExecutor } from "@/db/db";
import { createPooledJuniorSqlExecutor } from "./executor";

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

/** Use the migrated per-worker database that the shared setup truncates per test. */
export async function createMigratedJuniorSqlFixture(): Promise<JuniorPostgresFixture> {
  const config = getHarnessConfig();
  const pooled = createPooledJuniorSqlExecutor({
    applicationName: config.applicationName,
    connectionString: await getPostgresWorkerDatabaseUrl(config),
  });
  return {
    sql: pooled.db,
    close: () => pooled.close(),
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
