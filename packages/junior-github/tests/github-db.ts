import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createLocalPgliteFixture,
  type LocalPgliteFixture,
} from "@sentry/junior-testing/pglite";
import type { GitHubDb } from "../src/db/database";
import { githubSqlSchema } from "../src/db/schema";

const __dirname = dirname(fileURLToPath(import.meta.url));

export type GitHubFixture = LocalPgliteFixture<GitHubDb>;

/** Read one GitHub plugin migration file. */
export async function migrationSql(name: string): Promise<string> {
  return await readFile(resolve(__dirname, `../migrations/${name}`), "utf8");
}

/**
 * Create an in-memory database with the GitHub plugin tables. It skips the
 * native code backfill because that migration reads core tables.
 */
export async function createGitHubFixture(): Promise<GitHubFixture> {
  const fixture = await createLocalPgliteFixture<GitHubDb>(githubSqlSchema);
  for (const migrationFile of [
    "0000_pull_request_outcomes.sql",
    "0001_issue_outcomes.sql",
    "0002_pull_request_commit_composition.sql",
    "0003_pull_request_conversations.sql",
    "0004_marvelous_toad_men.sql",
    "0005_github_cost_associations.sql",
    "0006_fat_korvac.sql",
    "0007_shallow_millenium_guard.sql",
    "0009_nostalgic_thing.sql",
    "0010_installations.sql",
  ]) {
    await fixture.execute(await migrationSql(migrationFile));
  }
  return fixture;
}
