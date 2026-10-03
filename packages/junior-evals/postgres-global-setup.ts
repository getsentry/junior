import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  cleanupPostgresHarness,
  setupPostgresTemplate,
  type PostgresHarnessConfig,
} from "@sentry/junior-testing/postgres";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { migratePluginSchemas } from "@/chat/plugins/migrations";
import { createPostgresJuniorSqlExecutor } from "@/db/postgres";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

interface EvalTestProject {
  provide(key: "juniorPostgresHarness", value: PostgresHarnessConfig): void;
}

/**
 * Every first-party plugin that owns SQL tables. All evals share one schema,
 * so a test's plugin options never change which tables exist. A package
 * `junior-<name>` holds the plugin `<name>`.
 */
function pluginMigrationRoots(): { dir: string; pluginName: string }[] {
  const packagesDir = path.join(workspaceRoot, "packages");
  return readdirSync(packagesDir)
    .filter((name) => name.startsWith("junior-"))
    .map((name) => ({
      dir: path.join(packagesDir, name, "migrations"),
      pluginName: name.slice("junior-".length),
    }))
    .filter((root) => existsSync(root.dir));
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
        await migratePluginSchemas(executor, pluginMigrationRoots());
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
