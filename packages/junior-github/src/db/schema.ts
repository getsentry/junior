import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { z } from "zod";

export const githubPullRequestStateSchema = z.enum([
  "closed_unmerged",
  "merged",
  "open",
]);

export type GitHubPullRequestState = z.output<
  typeof githubPullRequestStateSchema
>;

/** Current provider projection for pull requests classified as Junior-owned. */
export const juniorGitHubPullRequests = pgTable(
  "junior_github_pull_requests",
  {
    pullRequestId: text("pull_request_id").primaryKey(),
    repositoryId: text("repository_id").notNull(),
    repositoryFullName: text("repository_full_name").notNull(),
    number: integer("number").notNull(),
    state: text("state").$type<GitHubPullRequestState>().notNull(),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull(),
    mergedAt: timestamp("merged_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("junior_github_pull_requests_repository_number_idx").on(
      table.repositoryId,
      table.number,
    ),
    index("junior_github_pull_requests_opened_at_idx").on(table.openedAt),
    index("junior_github_pull_requests_merged_at_idx").on(table.mergedAt),
    index("junior_github_pull_requests_closed_at_idx").on(table.closedAt),
    index("junior_github_pull_requests_state_idx").on(table.state),
  ],
);

export const githubSqlSchema = { juniorGitHubPullRequests };
