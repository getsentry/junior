import type {
  PluginConversationInboxItems,
  PluginLogger,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import { githubConversationIds } from "../conversation-footer.js";
import { logFailOpenFailure } from "../webhooks/fail-open-log.js";
import { isBotLogin } from "../webhooks/ownership.js";
import { closeGitHubIssueReviews, type GitHubIssueRef } from "./items.js";

const loginSchema = z.object({ login: z.string().min(1) });

// Only a pull request's issue carries `pull_request`. A deleted account has
// a null `user`.
const issueSchema = z.object({
  assignees: z.array(loginSchema).default([]),
  body: z.string().nullable().optional(),
  number: z.number().int().positive(),
  pull_request: z.unknown().optional(),
  user: loginSchema.nullable(),
});

const repositorySchema = z.object({ full_name: z.string().min(1) });

const issueClosedSchema = z.object({
  action: z.literal("closed"),
  issue: issueSchema,
  repository: repositorySchema,
});

const issueCommentSchema = z.object({
  action: z.literal("created"),
  comment: z.object({ user: loginSchema.nullable() }),
  issue: issueSchema,
  repository: repositorySchema,
});

interface CloseTarget {
  conversationIds: string[];
  issue: GitHubIssueRef;
  logins: string[];
  reason: string;
}

/**
 * The review items that one webhook delivery closes: each assignee's item
 * when the issue closes, or the commenter's item. Only an issue that Junior
 * opened has items, in the Conversations that its footer names.
 */
function closeTarget(
  eventName: string,
  body: unknown,
  botEmail: string | undefined,
): CloseTarget | undefined {
  let parsed: {
    issue: z.output<typeof issueSchema>;
    repository: { full_name: string };
  };
  let logins: string[];
  let reason: string;
  if (eventName === "issues") {
    const closed = issueClosedSchema.safeParse(body);
    if (!closed.success) return undefined;
    parsed = closed.data;
    logins = closed.data.issue.assignees.map((assignee) => assignee.login);
    reason = "The issue closed.";
  } else if (eventName === "issue_comment") {
    const comment = issueCommentSchema.safeParse(body);
    if (!comment.success) return undefined;
    parsed = comment.data;
    const commenter = comment.data.comment.user?.login;
    logins = commenter ? [commenter] : [];
    reason = "They commented on the issue.";
  } else {
    return undefined;
  }
  const { issue, repository } = parsed;
  if (
    issue.pull_request !== undefined ||
    !isBotLogin(issue.user?.login, botEmail)
  ) {
    return undefined;
  }
  const conversationIds = githubConversationIds(issue.body);
  if (logins.length === 0 || conversationIds.length === 0) return undefined;
  return {
    conversationIds,
    issue: { number: issue.number, repositoryFullName: repository.full_name },
    logins,
    reason,
  };
}

/**
 * Close the review items that a webhook delivery ends. The items are
 * optional, so a failure is logged and does not fail the delivery.
 */
export async function closeGitHubIssueReviewsForWebhook(args: {
  body: unknown;
  botEmail: string | undefined;
  deliveryId: string;
  eventName: string;
  inboxItems: PluginConversationInboxItems;
  log?: Pick<PluginLogger, "error" | "warn"> | undefined;
}): Promise<void> {
  const target = closeTarget(args.eventName, args.body, args.botEmail);
  if (!target) return;
  try {
    await closeGitHubIssueReviews({ inboxItems: args.inboxItems, ...target });
  } catch (error) {
    logFailOpenFailure(args.log, "GitHub issue review close failed", error, {
      deliveryId: args.deliveryId,
      number: target.issue.number,
      repository: target.issue.repositoryFullName,
    });
  }
}
