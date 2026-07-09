import type { TestProject } from "vitest/node";
import path from "node:path";
import {
  cleanupPostgresHarness,
  setupPostgresTemplate,
  type PostgresHarnessConfig,
} from "@sentry/junior-testing/postgres";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { migratePluginSchemas, readPluginMigrations } from "@/chat/plugins/db";
import type { JuniorSqlMigrationExecutor } from "@/db/db";
import { createPostgresJuniorSqlExecutor } from "@/db/postgres";

declare module "vitest" {
  export interface ProvidedContext {
    juniorPostgresHarness?: PostgresHarnessConfig;
  }
}

const TEST_DATABASE_URL = process.env.DATABASE_URL;

function assertLocalDatabaseUrl(databaseUrl: string): void {
  const { hostname } = new URL(databaseUrl);
  if (hostname !== "localhost" && hostname !== "127.0.0.1") {
    throw new Error(
      `Junior test database URL must point at localhost or 127.0.0.1, got ${hostname}`,
    );
  }
}

export interface JuniorPostgresHarnessOptions {
  migrateTemplate?(executor: JuniorSqlMigrationExecutor): Promise<void>;
}

/** Provide the migrated Junior Postgres harness when real database tests are enabled. */
export async function setupJuniorPostgresHarness(
  project: TestProject,
  options: JuniorPostgresHarnessOptions = {},
): Promise<() => Promise<void>> {
  if (!TEST_DATABASE_URL) {
    return async () => undefined;
  }
  assertLocalDatabaseUrl(TEST_DATABASE_URL);

  const config = await setupPostgresTemplate({
    applicationName: "junior-vitest",
    connectionString: TEST_DATABASE_URL,
    migrateTemplate: async (connectionString) => {
      const executor = createPostgresJuniorSqlExecutor({ connectionString });
      try {
        await migrateSchema(executor);
        await migratePluginSchemas(
          executor,
          readPluginMigrations({
            dir: path.resolve(process.cwd(), "../junior-scheduler/migrations"),
            pluginName: "scheduler",
          }),
        );
        await options.migrateTemplate?.(executor);
      } finally {
        await executor.close();
      }
    },
  });

  project.provide("juniorPostgresHarness", config);

  return async () => {
    await cleanupPostgresHarness(config);
  };
}

export default setupJuniorPostgresHarness;
