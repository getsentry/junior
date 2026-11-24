import {
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import * as z from "zod";

export const githubPullRequestStateSchema = z.enum([
  "closed_unmerged",
  "merged",
  "open",
]);

export type GitHubPullRequestState = z.output<
  typeof githubPullRequestStateSchema
>;

/**
 * What waits on the requester of a Junior pull request: merge it, or review
 * it. They take one, not both.
 */
export type GitHubPullRequestAction = "merge" | "review";

export const githubPullRequestCommitCompositionSchema = z.enum([
  "junior_only",
  "mixed",
]);

export type GitHubPullRequestCommitComposition = z.output<
  typeof githubPullRequestCommitCompositionSchema
>;

/** A merge conflict fix that Junior started: the event it published. */
export interface GitHubConflictFix {
  atMs: number;
  /** The head commit that the fix was for. */
  headSha: string;
}

/**
 * What Junior records for each pull request classified as Junior-owned. The
 * lifecycle, repository, number, and linked Conversations are in Junior's
 * code index.
 */
export const juniorGitHubPullRequests = pgTable("junior_github_pull_requests", {
  pullRequestId: text("pull_request_id").primaryKey(),
  commitComposition:
    text("commit_composition").$type<GitHubPullRequestCommitComposition>(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  /**
   * The requester's next action that Junior last derived from GitHub, and
   * shows in the Inbox. Null when no action waits on them.
   */
  nextAction: text("next_action").$type<GitHubPullRequestAction>(),
  /**
   * Webhooks that asked to check the next action. The check runs again
   * when this changes during a check.
   */
  readySyncRequests: integer("ready_sync_requests").notNull().default(0),
  /**
   * The request that runs the current check. Null when no check runs.
   */
  readySyncId: integer("ready_sync_id"),
  /** When the current check started. */
  readySyncAt: timestamp("ready_sync_at", { withTimezone: true }),
  /**
   * When a person last chose Resume on the merge conflict item.
   * It counts as activity by a person, so the fix count starts again.
   */
  conflictFixesResumedAt: timestamp("conflict_fixes_resumed_at", {
    withTimezone: true,
  }),
  /**
   * When Junior last asked the requester to resume a merge conflict fix
   * that did not land. It asks once after each Resume, so a Dismiss ends
   * the asks on the pull request.
   */
  conflictFixAskedAt: timestamp("conflict_fix_asked_at", {
    withTimezone: true,
  }),
  /**
   * The latest merge conflict fixes that Junior started, oldest first.
   * Only these count as fixes, so a merge or force push for work that a
   * person asked for does not.
   */
  conflictFixes: jsonb("conflict_fixes")
    .$type<GitHubConflictFix[]>()
    .notNull()
    .default([]),
});

/**
 * People who asked Junior to open or update a pull request. Each row links
 * the pull request to the Junior identity that acted. The user and any linked
 * GitHub account come from that identity in core when a webhook needs them,
 * so they stay correct when the person links an account later. The first row
 * for a number is the person who asked Junior to open it. The create tool
 * saves that row after GitHub opens the pull request.
 */
export const juniorGitHubPullRequestRequesters = pgTable(
  "junior_github_pull_request_requesters",
  {
    /** Lowercase `owner/name`. */
    repositoryFullName: text("repository_full_name").notNull(),
    number: integer("number").notNull(),
    /** Core `junior_identities.id` of the person who acted. */
    identityId: text("identity_id").notNull(),
    /** The Conversation where the person asked Junior to open the pull request. */
    conversationId: text("conversation_id"),
    /**
     * GitHub's id of the pull request (`databaseId`), the id of its Inbox
     * items. Set on the opener's row, so a Resume finds its pull request
     * without a name, also after a rename.
     */
    pullRequestId: text("pull_request_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.repositoryFullName, table.number, table.identityId],
    }),
  ],
);

export const githubSqlSchema = {
  juniorGitHubPullRequestRequesters,
  juniorGitHubPullRequests,
};
