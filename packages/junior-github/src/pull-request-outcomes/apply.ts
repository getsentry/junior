/**
 * The one write path for a pull request lifecycle outcome. The webhook and
 * the daily reconcile both use it, so the stored row, Junior's code index,
 * and the conversation chip change together.
 */
import type {
  CodeChangeInput,
  PluginCodeChanges,
  PluginConversationAnnotations,
  PluginConversationChanges,
  PluginLogger,
} from "@sentry/junior-plugin-api";
import {
  githubAnnotationChange,
  updateGitHubAnnotations,
} from "../annotations.js";
import type { GitHubDb } from "../db/database.js";
import { syncGitHubPullRequestRequesters } from "../pull-request-requesters/code-index.js";
import { logFailOpenFailure } from "../webhooks/fail-open-log.js";
import { endedGitHubPullRequestItemChanges } from "../webhooks/pull-request-action.js";
import {
  findGitHubPullRequest,
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
 * code index. A merged or closed pull request then marks the chip of the
 * conversation that asked for it and closes its Inbox items in one batch, so
 * no reader sees a merged chip next to an open item. Each other conversation
 * that the code index links gets its chip in its own write, so a stale
 * conversation id breaks only its own chip. The chips and items are optional UI, so a
 * failed write is logged and does not stop the work after it.
 */
export async function applyGitHubPullRequestOutcome(args: {
  annotations: PluginConversationAnnotations;
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
  if (state) {
    const conversationIds =
      (await findGitHubPullRequest(args.codeChanges, outcome))
        ?.conversationIds ?? [];
    const update = {
      repo: outcome.repositoryFullName,
      number: outcome.number,
      objectType: "code_change",
      status: state,
    } as const;
    if (ended) {
      try {
        await args.conversationChanges.apply({
          annotations: conversationIds.includes(ended.conversationId)
            ? [
                await githubAnnotationChange({
                  annotations: args.annotations,
                  conversationId: ended.conversationId,
                  update,
                }),
              ]
            : [],
          inboxItems: ended.inboxItems,
        });
      } catch (error) {
        logFailOpenFailure(
          args.log,
          "GitHub ended pull request change failed",
          error,
          { number: outcome.number, repository: outcome.repositoryFullName },
        );
      }
    }
    await updateGitHubAnnotations({
      annotations: args.annotations,
      conversationIds: conversationIds.filter(
        (id) => id !== ended?.conversationId,
      ),
      log: args.log,
      update,
    });
  }
  return recorded;
}
