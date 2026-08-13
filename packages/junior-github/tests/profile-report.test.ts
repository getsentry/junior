import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createLocalPgliteFixture,
  type LocalPgliteFixture,
} from "@sentry/junior-testing/pglite";
import { describe, expect, it } from "vitest";
import type { GitHubDb } from "../src/db/database";
import {
  githubSqlSchema,
  juniorGitHubIssues,
  juniorGitHubPullRequests,
} from "../src/db/schema";
import { buildGitHubProfileReport } from "../src/outcomes/profile-report";

const __dirname = dirname(fileURLToPath(import.meta.url));
type GitHubFixture = LocalPgliteFixture<GitHubDb>;

async function createGitHubFixture(): Promise<GitHubFixture> {
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
  ]) {
    await fixture.execute(
      await readFile(
        resolve(__dirname, `../migrations/${migrationFile}`),
        "utf8",
      ),
    );
  }
  await fixture.execute(`
    CREATE TABLE junior_identities (
      id text PRIMARY KEY,
      user_id text NOT NULL
    );
    CREATE TABLE junior_conversations (
      conversation_id text PRIMARY KEY,
      actor_identity_id text
    );
  `);
  return fixture;
}

describe("GitHub profile reports", () => {
  it("attributes junior-owned outcomes through conversation actors", async () => {
    const fixture = await createGitHubFixture();
    const nowMs = Date.parse("2026-07-31T12:00:00.000Z");
    const openedAt = new Date("2026-07-20T12:00:00.000Z");
    const mergedAt = new Date("2026-07-21T12:00:00.000Z");
    try {
      await fixture.execute(`
        INSERT INTO junior_identities (id, user_id) VALUES
          ('identity-alice', 'user-alice'),
          ('identity-bob', 'user-bob');
        INSERT INTO junior_conversations (conversation_id, actor_identity_id) VALUES
          ('slack:C1:alice', 'identity-alice'),
          ('slack:C1:bob', 'identity-bob');
      `);
      await fixture
        .db()
        .insert(juniorGitHubPullRequests)
        .values([
          {
            pullRequestId: "pr-alice",
            repositoryId: "repo-1",
            repositoryFullName: "getsentry/junior",
            number: 1,
            state: "merged",
            conversationIds: ["slack:C1:alice"],
            openedAt,
            mergedAt,
            updatedAt: mergedAt,
          },
          {
            pullRequestId: "pr-bob",
            repositoryId: "repo-1",
            repositoryFullName: "getsentry/junior",
            number: 2,
            state: "open",
            conversationIds: ["slack:C1:bob"],
            openedAt,
            updatedAt: openedAt,
          },
        ]);
      await fixture
        .db()
        .insert(juniorGitHubIssues)
        .values([
          {
            issueId: "issue-alice",
            repositoryId: "repo-1",
            repositoryFullName: "getsentry/junior",
            number: 10,
            state: "open",
            conversationIds: ["slack:C1:alice"],
            openedAt,
            updatedAt: openedAt,
          },
        ]);

      const alice = await buildGitHubProfileReport({
        db: fixture.db(),
        nowMs,
        userId: "user-alice",
      });
      expect(alice?.title).toBe("Code changes");
      expect(alice?.metrics).toEqual([
        { label: "PRs opened · 30d", value: "1" },
        { label: "PRs merged · 30d", value: "1" },
        { label: "Issues opened · 30d", value: "1" },
        { label: "PR merge rate · 30d", value: "100%" },
      ]);
      expect(alice?.widgets?.[0]?.categories.at(-12)).toEqual({
        id: "2026-07-20",
        label: "2026-07-20",
        values: { created: 1 },
      });

      const bob = await buildGitHubProfileReport({
        db: fixture.db(),
        nowMs,
        userId: "user-bob",
      });
      expect(bob?.metrics).toEqual([
        { label: "PRs opened · 30d", value: "1" },
        { label: "PRs merged · 30d", value: "0" },
        { label: "Issues opened · 30d", value: "0" },
        { label: "PR merge rate · 30d", value: "—" },
      ]);

      await expect(
        buildGitHubProfileReport({
          db: fixture.db(),
          nowMs,
          userId: "user-nobody",
        }),
      ).resolves.toBeUndefined();
    } finally {
      await fixture.close();
    }
  });
});
