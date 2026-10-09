import type { TestProject } from "vitest/node";
import {
  cleanupPostgresHarness,
  setupPostgresTemplate,
  type PostgresHarnessConfig,
} from "@sentry/junior-testing/postgres";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import type { JuniorSqlMigrationExecutor } from "@/db/db";
import { createPostgresJuniorSqlExecutor } from "@/db/postgres";

declare module "vitest" {
  export interface ProvidedContext {
    juniorPostgresHarness?: PostgresHarnessConfig;
  }
}

const TEST_DATABASE_URL = process.env.DATABASE_URL;

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
  const config = await setupPostgresTemplate({
    applicationName: "junior-vitest",
    connectionString: TEST_DATABASE_URL,
    migrateTemplate: async (connectionString) => {
      const executor = createPostgresJuniorSqlExecutor({ connectionString });
      try {
        await migrateSchema(executor);
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
