import {
  getPostgresWorkerDatabaseUrl,
  parsePostgresHarnessConfig,
} from "@sentry/junior-testing/postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { inject } from "vitest";
import type { GitHubDb } from "../src/db/database";
import { githubSqlSchema } from "../src/db/schema";

export interface GitHubFixture {
  db(): GitHubDb;
  close(): Promise<void>;
}

/**
 * Connect to this worker's migrated database. The setup file empties its
 * tables before each test.
 */
export async function createGitHubFixture(): Promise<GitHubFixture> {
  const config = parsePostgresHarnessConfig(inject("githubPostgresHarness"));
  const pool = new pg.Pool({
    application_name: config.applicationName,
    connectionString: await getPostgresWorkerDatabaseUrl(config),
  });
  return {
    db: () => drizzle(pool, { schema: githubSqlSchema }),
    close: () => pool.end(),
  };
}
