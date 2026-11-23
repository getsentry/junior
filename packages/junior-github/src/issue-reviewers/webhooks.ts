import type {
  PluginConversationInboxItems,
  PluginLogger,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import type { GitHubDb } from "../db/database.js";
import { logFailOpenFailure } from "../webhooks/fail-open-log.js";
import { closeGitHubIssueReviews } from "./items.js";
import type { GitHubIssueRef } from "./store.js";

const repositorySchema = z.object({ full_name: z.string().min(1) });

const issueClosedSchema = z.object({
  action: z.literal("closed"),
  issue: z.object({ number: z.number().int().positive() }),
  repository: repositorySchema,
});

// Only a pull request's issue carries `pull_request`. A deleted account's
// comment has a null `user`.
const issueCommentSchema = z.object({
  action: z.literal("created"),
  comment: z.object({
    user: z.object({ login: z.string().min(1) }).nullable(),
  }),
  issue: z.object({
    number: z.number().int().positive(),
    pull_request: z.unknown().optional(),
  }),
  repository: repositorySchema,
});

/** The review items that one webhook delivery closes. */
function closeTarget(
  eventName: string,
  body: unknown,
): { issue: GitHubIssueRef; logins?: string[]; reason: string } | undefined {
  if (eventName === "issues") {
    const parsed = issueClosedSchema.safeParse(body);
    if (!parsed.success) return undefined;
    return {
      issue: {
        number: parsed.data.issue.number,
        repositoryFullName: parsed.data.repository.full_name,
      },
      reason: "The issue closed.",
    };
  }
  if (eventName !== "issue_comment") return undefined;
  const parsed = issueCommentSchema.safeParse(body);
  if (!parsed.success || parsed.data.issue.pull_request !== undefined) {
    return undefined;
  }
  const login = parsed.data.comment.user?.login;
  if (!login) return undefined;
  return {
    issue: {
      number: parsed.data.issue.number,
      repositoryFullName: parsed.data.repository.full_name,
    },
    logins: [login],
    reason: "They commented on the issue.",
  };
}

/**
 * Close the review items that a webhook delivery ends: every item of an
 * issue that closed, or the item of the person who commented. The items are
 * optional, so a failure is logged and does not fail the delivery.
 */
export async function closeGitHubIssueReviewsForWebhook(args: {
  body: unknown;
  db: GitHubDb;
  deliveryId: string;
  eventName: string;
  inboxItems: PluginConversationInboxItems;
  log?: Pick<PluginLogger, "error" | "warn"> | undefined;
}): Promise<void> {
  const target = closeTarget(args.eventName, args.body);
  if (!target) return;
  try {
    await closeGitHubIssueReviews({
      db: args.db,
      inboxItems: args.inboxItems,
      ...target,
    });
  } catch (error) {
    logFailOpenFailure(args.log, "GitHub issue review close failed", error, {
      deliveryId: args.deliveryId,
      number: target.issue.number,
      repository: target.issue.repositoryFullName,
    });
  }
}
