/**
 * The one write path for a pull request lifecycle outcome. The webhook and
 * the daily reconcile both use it, so the stored row, Junior's code index,
 * and the Inbox items change together. Annotations read the pull request
 * live, so an outcome changes none.
 */
import type {
  CodeChangeInput,
  PluginCodeChanges,
  PluginConversationChanges,
  PluginLogger,
} from "@sentry/junior-plugin-api";
import type { GitHubDb } from "../db/database.js";
import { syncGitHubPullRequestRequesters } from "../pull-request-requesters/code-index.js";
import { logFailOpenFailure } from "../webhooks/fail-open-log.js";
import { endedGitHubPullRequestItemChanges } from "../webhooks/pull-request-action.js";
import {
  type GitHubPullRequestOutcomeInput,
  recordGitHubPullRequestOutcome,
} from "./store.js";

/**
 * Write a pull request outcome as a code change in Junior's code index. It
 * names no Conversations, so the linked ones stay.
 */
export function githubCodeChange(
  outcome: GitHubPullRequestOutcomeInput,
): CodeChangeInput {
  return {
    closedAt: outcome.closedAt,
    mergedAt: outcome.mergedAt,
    number: outcome.number,
    openedAt: outcome.openedAt,
    providerId: outcome.pullRequestId,
    repository: {
      name: outcome.repositoryFullName,
      providerId: outcome.repositoryId,
    },
    state: outcome.state === "closed_unmerged" ? "closed" : outcome.state,
    title: outcome.title,
    updatedAt: outcome.updatedAt,
  };
}

/**
 * Record one pull request outcome. When the stored row changes, update the
 * code index. A merged or closed pull request then closes the Inbox items
 * of the conversation that asked for it in one batch. The items are
 * optional UI, so a failed write is logged and does not stop the work after
 * it.
 */
export async function applyGitHubPullRequestOutcome(args: {
  codeChanges: PluginCodeChanges;
  conversationChanges: PluginConversationChanges;
  db: GitHubDb;
  log?: Pick<PluginLogger, "error" | "warn"> | undefined;
  outcome: GitHubPullRequestOutcomeInput;
}): Promise<Awaited<ReturnType<typeof recordGitHubPullRequestOutcome>>> {
  const { outcome } = args;
  const state =
    outcome.state === "open"
      ? undefined
      : outcome.state === "merged"
        ? "merged"
        : "closed";
  // Find the conversation that owns the items before the row is written.
  // When this read fails, the row stays open, so the next delivery or
  // reconcile applies the whole outcome again.
  const ended = state
    ? await endedGitHubPullRequestItemChanges({
        db: args.db,
        state,
        target: outcome,
      })
    : undefined;
  const recorded = await recordGitHubPullRequestOutcome(args.db, outcome);
  if (!recorded.applied) return recorded;
  await args.codeChanges.record(githubCodeChange(outcome));
  // After the record, so a requester that the create tool saves meanwhile
  // reaches the code change.
  await syncGitHubPullRequestRequesters({
    codeChanges: args.codeChanges,
    db: args.db,
    numbers: [outcome.number],
    repositoryFullName: outcome.repositoryFullName,
  });
  if (ended) {
    try {
      await args.conversationChanges.apply({ inboxItems: ended.inboxItems });
    } catch (error) {
      logFailOpenFailure(
        args.log,
        "GitHub ended pull request change failed",
        error,
        { number: outcome.number, repository: outcome.repositoryFullName },
      );
    }
  }
  return recorded;
}
