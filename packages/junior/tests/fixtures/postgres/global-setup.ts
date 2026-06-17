import type { TestProject } from "vitest/node";
import {
  cleanupPostgresHarness,
  setupPostgresTemplate,
  type PostgresHarnessConfig,
} from "@sentry/junior-testing/postgres";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { createPostgresJuniorSqlExecutor } from "@/chat/sql/postgres";

declare module "vitest" {
  export interface ProvidedContext {
    juniorPostgresHarness?: PostgresHarnessConfig;
  }
}

const TEST_DATABASE_URL = process.env.JUNIOR_TEST_DATABASE_URL;

/** Provide the migrated Postgres harness when real database tests are enabled. */
export default async function setup(
  project: TestProject,
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
