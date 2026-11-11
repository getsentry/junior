import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createEmptyPostgresDatabase,
  getPostgresWorkerDatabaseUrl,
  parsePostgresHarnessConfig,
} from "@sentry/junior-testing/postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { inject } from "vitest";
import type { GitHubDb } from "../src/db/database";
import { githubSqlSchema } from "../src/db/schema";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * GitHub plugin migrations that tests apply. It skips 0008, the native code
 * backfill, because that migration reads core tables.
 */
export const githubTestMigrations = [
  "0000_pull_request_outcomes.sql",
  "0001_issue_outcomes.sql",
  "0002_pull_request_commit_composition.sql",
  "0003_pull_request_conversations.sql",
  "0004_marvelous_toad_men.sql",
  "0005_github_cost_associations.sql",
  "0006_fat_korvac.sql",
  "0007_shallow_millenium_guard.sql",
  "0009_nostalgic_thing.sql",
  "0010_sleepy_slayback.sql",
];

export interface GitHubFixture {
  db(): GitHubDb;
  execute(statement: string, params?: readonly unknown[]): Promise<void>;
  close(): Promise<void>;
}

/** Read one GitHub plugin migration file. */
export async function migrationSql(name: string): Promise<string> {
  return await readFile(resolve(__dirname, `../migrations/${name}`), "utf8");
}

function harnessConfig() {
  return parsePostgresHarnessConfig(inject("githubPostgresHarness"));
}

function poolFixture(
  applicationName: string,
  connectionString: string,
  dropDatabase?: () => Promise<void>,
): GitHubFixture {
  const pool = new pg.Pool({
    application_name: applicationName,
    connectionString,
  });
  return {
    db: () => drizzle(pool, { schema: githubSqlSchema }),
    execute: async (statement, params = []) => {
      await pool.query(statement, [...params]);
    },
    close: async () => {
      await pool.end();
      await dropDatabase?.();
    },
  };
}

/**
 * Connect to this worker's migrated database. The setup file empties its
 * tables before each test.
 */
export async function createGitHubFixture(): Promise<GitHubFixture> {
  const config = harnessConfig();
  return poolFixture(
    config.applicationName,
    await getPostgresWorkerDatabaseUrl(config),
  );
}

/** Create an empty database for a migration test. Close drops it. */
export async function createEmptyGitHubFixture(): Promise<GitHubFixture> {
  const config = harnessConfig();
  const database = await createEmptyPostgresDatabase(config);
  return poolFixture(
    config.applicationName,
    database.connectionString,
    database.close,
  );
}
