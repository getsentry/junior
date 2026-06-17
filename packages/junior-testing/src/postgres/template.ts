import type { PostgresHarnessConfig, PostgresHarnessOptions } from "./config";
import { createPostgresHarnessConfig } from "./config";
import {
  cleanupPostgresTestDatabases,
  createEmptyPostgresTestDatabase,
} from "./admin";

export interface SetupPostgresTemplateOptions extends PostgresHarnessOptions {
  migrateTemplate(connectionString: string): Promise<void>;
}

/** Create a migrated Postgres template database for one Vitest run. */
export async function setupPostgresTemplate(
  options: SetupPostgresTemplateOptions,
): Promise<PostgresHarnessConfig> {
  const config = createPostgresHarnessConfig(options);
  await createEmptyPostgresTestDatabase(config, config.templateDatabaseName);
  try {
    await options.migrateTemplate(config.templateConnectionString);
  } catch (error) {
    await cleanupPostgresHarness(config);
    throw error;
  }
  return config;
}

/** Drop every database created for one Postgres test harness run. */
export async function cleanupPostgresHarness(
  config: PostgresHarnessConfig,
): Promise<void> {
  await cleanupPostgresTestDatabases(config, config.databasePrefix);
}
