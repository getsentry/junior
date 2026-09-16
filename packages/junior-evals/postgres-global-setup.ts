import {
  cleanupPostgresHarness,
  setupPostgresTemplate,
  type PostgresHarnessConfig,
} from "@sentry/junior-testing/postgres";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { createPostgresJuniorSqlExecutor } from "@/db/postgres";

interface EvalTestProject {
  provide(key: "juniorPostgresHarness", value: PostgresHarnessConfig): void;
}

function assertLocalDatabaseUrl(databaseUrl: string): void {
  const { hostname } = new URL(databaseUrl);
  if (hostname !== "localhost" && hostname !== "127.0.0.1") {
    throw new Error(
      `Junior eval database URL must point at localhost or 127.0.0.1, got ${hostname}`,
    );
  }
}

/** Set up migrated Postgres databases for eval package tests. */
export default async function setup(
  project: EvalTestProject,
): Promise<() => Promise<void>> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    return async () => undefined;
  }
  assertLocalDatabaseUrl(databaseUrl);

  const config = await setupPostgresTemplate({
    applicationName: "junior-evals-vitest",
    connectionString: databaseUrl,
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
