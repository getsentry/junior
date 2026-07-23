import { sql } from "drizzle-orm";
import { index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { z } from "zod";

export const githubPullRequestStateSchema = z.enum([
  "closed_unmerged",
  "merged",
  "open",
]);

export type GitHubPullRequestState = z.output<
  typeof githubPullRequestStateSchema
>;

export const githubPullRequestCommitCompositionSchema = z.enum([
  "junior_only",
  "mixed",
]);

export type GitHubPullRequestCommitComposition = z.output<
  typeof githubPullRequestCommitCompositionSchema
>;

export const githubIssueStateSchema = z.enum(["closed", "open"]);

export type GitHubIssueState = z.output<typeof githubIssueStateSchema>;

/** Current provider projection for issues classified as Junior-owned. */
export const juniorGitHubIssues = pgTable(
  "junior_github_issues",
  {
    issueId: text("issue_id").primaryKey(),
    repositoryId: text("repository_id").notNull(),
    repositoryFullName: text("repository_full_name").notNull(),
    number: integer("number").notNull(),
    state: text("state").$type<GitHubIssueState>().notNull(),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("junior_github_issues_opened_at_idx").on(table.openedAt),
    index("junior_github_issues_closed_at_idx").on(table.closedAt),
    index("junior_github_issues_open_idx")
      .on(table.issueId)
      .where(sql`${table.state} = 'open'`),
  ],
);

/** Current provider projection for pull requests classified as Junior-owned. */
export const juniorGitHubPullRequests = pgTable(
  "junior_github_pull_requests",
  {
    pullRequestId: text("pull_request_id").primaryKey(),
    repositoryId: text("repository_id").notNull(),
    repositoryFullName: text("repository_full_name").notNull(),
    number: integer("number").notNull(),
    state: text("state").$type<GitHubPullRequestState>().notNull(),
    commitComposition:
      text("commit_composition").$type<GitHubPullRequestCommitComposition>(),
    conversationIds: text("conversation_ids")
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull(),
    mergedAt: timestamp("merged_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("junior_github_pull_requests_opened_at_idx").on(table.openedAt),
    index("junior_github_pull_requests_merged_at_idx").on(table.mergedAt),
    index("junior_github_pull_requests_closed_at_idx").on(table.closedAt),
    index("junior_github_pull_requests_open_idx")
      .on(table.pullRequestId)
      .where(sql`${table.state} = 'open'`),
  ],
);

export const githubSqlSchema = { juniorGitHubIssues, juniorGitHubPullRequests };
