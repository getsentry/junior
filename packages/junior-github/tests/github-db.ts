import {
  createPostgresTestFixture,
  type PostgresTestFixture,
} from "@sentry/junior-testing/postgres/fixture";
import { drizzle } from "drizzle-orm/node-postgres";
import type { GitHubDb } from "../src/db/database";
import { type MemoryCodeIndex, memoryCodeIndex } from "./code-index";

export type GitHubFixture = PostgresTestFixture<GitHubDb> & {
  /** Junior's code index, which core keeps next to the plugin tables. */
  codeIndex: MemoryCodeIndex;
};

/** Connect to this worker's migrated GitHub plugin database. */
export async function createGitHubFixture(): Promise<GitHubFixture> {
  const fixture = await createPostgresTestFixture((pool) =>
    drizzle({ client: pool }),
  );
  return { ...fixture, codeIndex: memoryCodeIndex() };
}
