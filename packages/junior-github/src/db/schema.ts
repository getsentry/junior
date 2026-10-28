import { sql } from "drizzle-orm";
import {
  index,
  integer,
  pgTable,
  primaryKey,
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

export const githubPullRequestCommitCompositionSchema = z.enum([
  "junior_only",
  "mixed",
]);

export type GitHubPullRequestCommitComposition = z.output<
  typeof githubPullRequestCommitCompositionSchema
>;

export const githubIssueStateSchema = z.enum(["closed", "open"]);

export type GitHubIssueState = z.output<typeof githubIssueStateSchema>;

export const githubIssueStateReasonSchema = z.enum([
  "completed",
  "duplicate",
  "not_planned",
  "reopened",
]);

export type GitHubIssueStateReason = z.output<
  typeof githubIssueStateReasonSchema
>;

/** Current provider projection for issues classified as Junior-owned. */
export const juniorGitHubIssues = pgTable(
  "junior_github_issues",
  {
    issueId: text("issue_id").primaryKey(),
    repositoryId: text("repository_id").notNull(),
    repositoryFullName: text("repository_full_name").notNull(),
    number: integer("number").notNull(),
    state: text("state").$type<GitHubIssueState>().notNull(),
    stateReason: text("state_reason").$type<GitHubIssueStateReason>(),
    conversationIds: text("conversation_ids")
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
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
    index("junior_github_pull_requests_unmerged_conversations_idx")
      .using("gin", table.conversationIds)
      .where(sql`${table.state} <> 'merged'`),
  ],
);

/** Many-to-many links between tracked pull requests and tracked issues. */
export const juniorGitHubPullRequestIssues = pgTable(
  "junior_github_pull_request_issues",
  {
    pullRequestId: text("pull_request_id")
      .notNull()
      .references(() => juniorGitHubPullRequests.pullRequestId, {
        onDelete: "cascade",
      }),
    issueRepositoryFullName: text("issue_repository_full_name").notNull(),
    issueNumber: integer("issue_number").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.pullRequestId,
        table.issueRepositoryFullName,
        table.issueNumber,
      ],
    }),
  ],
);

/**
 * People who asked Junior to open or update a pull request. Each row links
 * the pull request to the Junior identity that acted. The user and any linked
 * GitHub account come from that identity in core when a webhook needs them,
 * so they stay correct when the person links an account later. The first row
 * for a number is the person who asked Junior to open it.
 *
 * The create tool writes a pending row with no `number` before GitHub opens
 * the pull request, so the `opened` webhook can read it. GitHub has not given
 * a number yet, so the pending row names the head branch. After GitHub opens
 * the pull request, the tool replaces it with a row that has the number and
 * no head branch. A failed create removes the pending row.
 */
export const juniorGitHubPullRequestRequesters = pgTable(
  "junior_github_pull_request_requesters",
  {
    /** Lowercase `owner/name`. */
    repositoryFullName: text("repository_full_name").notNull(),
    /** Null only while the create call waits for GitHub. */
    number: integer("number"),
    /** Set only on pending rows, which are found by it. */
    headBranch: text("head_branch"),
    /** Core `junior_identities.id` of the person who acted. */
    identityId: text("identity_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("junior_github_pull_request_requesters_number_uidx")
      .on(table.repositoryFullName, table.number, table.identityId)
      .where(sql`${table.number} IS NOT NULL`),
    uniqueIndex("junior_github_pull_request_requesters_pending_uidx")
      .on(table.repositoryFullName, table.headBranch, table.identityId)
      .where(sql`${table.number} IS NULL`),
  ],
);

export const githubSqlSchema = {
  juniorGitHubIssues,
  juniorGitHubPullRequestIssues,
  juniorGitHubPullRequestRequesters,
  juniorGitHubPullRequests,
};
