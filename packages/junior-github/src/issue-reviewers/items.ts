/**
 * "Review requested" Inbox items for the people whose review or decision a
 * Junior issue waits on. `github_createIssue` assigns them on GitHub and adds
 * one item for each, in the Conversation that asked for the issue. Only
 * `review_by` adds items, so an assignment that claims an issue has no item.
 * The item closes as done when the issue closes, or when that person
 * comments on the issue (`webhooks.ts`) or reacts to it (`reactions.ts`).
 * Unassigning the person withdraws the ask, so it dismisses their item. A
 * close for a person who has no item does nothing. A reopen does not bring
 * an item back.
 */
import type {
  PluginConversationInboxItems,
  PluginInboxItems,
} from "@sentry/junior-plugin-api";
import pLimit from "p-limit";

/** One issue, as its review items name it. */
export interface GitHubIssueRef {
  number: number;
  repositoryFullName: string;
}

// Inbox writes that one issue makes at once.
const ITEM_WRITE_CONCURRENCY = 4;

function issueReviewDedupeKey(issue: GitHubIssueRef, login: string): string {
  return `issue-review:${issue.repositoryFullName}#${issue.number}:${login}`.toLowerCase();
}

/** Add one item for each person whom the new issue waits on. */
export async function requestGitHubIssueReviews(args: {
  inboxItems: PluginInboxItems;
  issue: GitHubIssueRef & { title: string; url: string };
  reviewers: Array<{ identityId: string; login: string }>;
}): Promise<void> {
  const { issue } = args;
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
 * Close the review items of these people on an issue, in each Conversation
 * that the issue names.
 */
export async function closeGitHubIssueReviews(args: {
  conversationIds: readonly string[];
  inboxItems: PluginConversationInboxItems;
  issue: GitHubIssueRef;
  logins: readonly string[];
  reason: string;
  status: "done" | "dismissed";
}): Promise<void> {
  const closes = args.conversationIds.flatMap((conversationId) =>
    args.logins.map((login) => ({ conversationId, login })),
  );
  await pLimit(ITEM_WRITE_CONCURRENCY).map(
    closes,
    ({ conversationId, login }) =>
      args.inboxItems.forConversation(conversationId).close({
        dedupeKey: issueReviewDedupeKey(args.issue, login),
        reason: args.reason,
        status: args.status,
      }),
  );
}
