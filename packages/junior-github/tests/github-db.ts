import {
  createPostgresTestFixture,
  type PostgresTestFixture,
} from "@sentry/junior-testing/postgres/fixture";
import { drizzle } from "drizzle-orm/node-postgres";
import type { GitHubDb } from "../src/db/database";
import { githubSqlSchema } from "../src/db/schema";

export type GitHubFixture = PostgresTestFixture<GitHubDb>;

/** Connect to this worker's migrated GitHub plugin database. */
export async function createGitHubFixture(): Promise<GitHubFixture> {
  return await createPostgresTestFixture((pool) =>
    drizzle(pool, { schema: githubSqlSchema }),
  );
}
