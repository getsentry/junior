import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import type { TestProject } from "vitest/node";
import {
  assertLocalPostgresUrl,
  cleanupPostgresHarness,
  setupPostgresTemplate,
  type PostgresHarnessConfig,
} from "@sentry/junior-testing/postgres";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { migratePluginSchemas } from "@/chat/plugins/migrations";
import type { JuniorSqlMigrationExecutor } from "@/db/db";
import { createPostgresJuniorSqlExecutor } from "@/db/postgres";

declare module "vitest" {
  export interface ProvidedContext {
    juniorPostgresHarness?: PostgresHarnessConfig;
  }
}

const TEST_DATABASE_URL = process.env["DATABASE_URL"];

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
  assertLocalPostgresUrl(TEST_DATABASE_URL);

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

/**
 * Add the tables of every first-party plugin, and the owner table of test
 * plugins' Inbox items (`tests/fixtures/plugin-inbox-owners.ts`). Inbox reads
 * join the owner table of each registered plugin, so the tables exist
 * whatever plugins a test registers, as in a deployment.
 */
async function migrateTestPluginTables(
  executor: JuniorSqlMigrationExecutor,
): Promise<void> {
  const packagesDir = path.resolve(process.cwd(), "..");
  await migratePluginSchemas(
    executor,
    readdirSync(packagesDir)
      .filter((name) => name.startsWith("junior-"))
      .map((name) => ({
        dir: path.join(packagesDir, name, "migrations"),
        pluginName: name.slice("junior-".length),
      }))
      .filter((root) => existsSync(root.dir)),
  );
  await executor.execute(
    "CREATE TABLE test_plugin_inbox_owners (subject_id text PRIMARY KEY, conversation_id text NOT NULL)",
  );
}

/** Provide the harness with the plugin tables that tests use. */
export default function setup(
  project: TestProject,
): Promise<() => Promise<void>> {
  return setupJuniorPostgresHarness(project, {
    migrateTemplate: migrateTestPluginTables,
  });
}
