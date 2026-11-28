import pg from "pg";
import type { PostgresHarnessConfig, PostgresHarnessOptions } from "./config";
import { createPostgresHarnessConfig } from "./config";
import {
  cleanupPostgresTestDatabases,
  createEmptyPostgresTestDatabase,
} from "./admin";

export interface SetupPostgresTemplateOptions extends PostgresHarnessOptions {
  migrateTemplate(connectionString: string): Promise<void>;
}

// Autoanalyze writes planner stats while tests run, so a statement cost then
// depends on the tests before it. Worker databases copy these settings.
async function disableAutovacuum(connectionString: string): Promise<void> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query(`
DO $$
DECLARE
  name text;
BEGIN
  FOR name IN
    SELECT format('%I.%I', n.nspname, c.relname)
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
  LOOP
    EXECUTE format('ALTER TABLE %s SET (autovacuum_enabled = false)', name);
  END LOOP;
END $$;
`);
  } finally {
    await client.end();
  }
}

/** Create a migrated Postgres template database for one Vitest run. */
export async function setupPostgresTemplate(
  options: SetupPostgresTemplateOptions,
): Promise<PostgresHarnessConfig> {
  const config = createPostgresHarnessConfig(options);
  await createEmptyPostgresTestDatabase(config, config.templateDatabaseName);
  try {
    await options.migrateTemplate(config.templateConnectionString);
    await disableAutovacuum(config.templateConnectionString);
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
