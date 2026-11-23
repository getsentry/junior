/**
 * "Review requested" Inbox items for the people whose review or decision a
 * Junior issue waits on. `github_createIssue` names them. Each person gets
 * one item, in the Conversation that asked for the issue, assigned to them.
 * The item closes as done when the issue closes, or when that person
 * comments on the issue (`webhooks.ts`) or reacts to it (`reactions.ts`).
 * A reopen does not bring it back.
 */
import type {
  PluginConversationInboxItems,
  PluginInboxItems,
} from "@sentry/junior-plugin-api";
import pLimit from "p-limit";
import type { GitHubDb } from "../db/database.js";
import {
  deleteGitHubIssueReviewers,
  listGitHubIssueReviewers,
  recordGitHubIssueReviewers,
  type GitHubIssueRef,
} from "./store.js";

// Inbox writes that one issue makes at once.
const ITEM_WRITE_CONCURRENCY = 4;

function issueReviewDedupeKey(issue: GitHubIssueRef, login: string): string {
  return `issue-review:${issue.repositoryFullName}#${issue.number}:${login}`.toLowerCase();
}

/**
 * Save the reviewers of a new issue, then add one item for each. The rows
 * come first, so a webhook that closes an item always finds its row.
 */
export async function requestGitHubIssueReviews(args: {
  conversationId: string;
  db: GitHubDb;
  inboxItems: PluginInboxItems;
  issue: GitHubIssueRef & { title: string; url: string };
  reviewers: Array<{ identityId: string; login: string }>;
}): Promise<void> {
  const { issue } = args;
  await recordGitHubIssueReviewers(args.db, {
    conversationId: args.conversationId,
    logins: args.reviewers.map((reviewer) => reviewer.login),
    number: issue.number,
    repositoryFullName: issue.repositoryFullName,
  });
  await pLimit(ITEM_WRITE_CONCURRENCY).map(args.reviewers, (reviewer) =>
    args.inboxItems.upsert({
      assigneeIdentityIds: [reviewer.identityId],
      body: `#${issue.number} waits on your review.\n\n${issue.url}`,
      dedupeKey: issueReviewDedupeKey(issue, reviewer.login),
      subject: {
        id: issue.url,
        title: `${issue.title} (#${issue.number})`,
        url: issue.url,
      },
      title: `Review requested · #${issue.number}`,
      waitsOnAssignees: true,
    }),
  );
}

/**
 * Close the review items of an issue, as done unless `status` says, and drop
 * their rows. With `logins`, close only the items of those people.
 */
export async function closeGitHubIssueReviews(args: {
  db: GitHubDb;
  inboxItems: PluginConversationInboxItems;
  issue: GitHubIssueRef;
  logins?: string[];
  reason: string;
  status?: "done" | "dismissed";
}): Promise<void> {
  const logins = args.logins?.map((login) => login.toLowerCase());
  const reviewers = (
    await listGitHubIssueReviewers(args.db, args.issue)
  ).filter((reviewer) => !logins || logins.includes(reviewer.login));
  if (reviewers.length === 0) return;
  await pLimit(ITEM_WRITE_CONCURRENCY).map(reviewers, (reviewer) =>
    args.inboxItems.forConversation(reviewer.conversationId).close({
      dedupeKey: issueReviewDedupeKey(args.issue, reviewer.login),
      reason: args.reason,
      status: args.status ?? "done",
    }),
  );
  await deleteGitHubIssueReviewers(
    args.db,
    args.issue,
    reviewers.map((reviewer) => reviewer.login),
  );
}
