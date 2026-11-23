/**
 * The one write path for a pull request lifecycle outcome. The webhook and
 * the daily reconcile both use it, so the stored row, Junior's code index,
 * and the conversation chip change together.
 */
import {
  MAX_CONVERSATION_CHANGES,
  type CodeChangeInput,
  type CodeChangePublisher,
  type ConversationAnnotationChange,
  type ConversationInboxItemChange,
  type PluginConversationAnnotations,
  type PluginConversationChanges,
  type PluginLogger,
} from "@sentry/junior-plugin-api";
import { githubAnnotationChanges } from "../annotations.js";
import type { GitHubDb } from "../db/database.js";
import { logFailOpenFailure } from "../webhooks/fail-open-log.js";
import { endedGitHubPullRequestItemChanges } from "../webhooks/pull-request-action.js";
import {
  type GitHubPullRequestOutcomeInput,
  recordGitHubPullRequestOutcome,
} from "./store.js";

/** Write a pull request outcome as a code change in Junior's code index. */
export function githubCodeChange(
  outcome: GitHubPullRequestOutcomeInput,
  conversationIds: string[],
): CodeChangeInput {
  return {
    closedAt: outcome.closedAt,
    conversationIds,
    draft: outcome.draft,
    mergedAt: outcome.mergedAt,
    number: outcome.number,
    openedAt: outcome.openedAt,
    providerId: outcome.pullRequestId,
    repository: {
      name: outcome.repositoryFullName,
      providerId: outcome.repositoryId,
      url: `https://github.com/${outcome.repositoryFullName}`,
    },
    size: outcome.size,
    state: outcome.state === "closed_unmerged" ? "closed" : outcome.state,
    title: outcome.title,
    updatedAt: outcome.updatedAt,
    url: `https://github.com/${outcome.repositoryFullName}/pull/${outcome.number}`,
  };
}

/**
 * Save the item closes with the chips in one batch. The chips of the
 * conversation that owns the items go first. A pull request with more
 * linked conversations than one batch holds saves the other chips after.
 */
async function applyEndedChanges(
  changes: PluginConversationChanges,
  batch: {
    annotations: ConversationAnnotationChange[];
    inboxItems: ConversationInboxItemChange[];
  },
): Promise<void> {
  const owners = new Set(batch.inboxItems.map((item) => item.conversationId));
  const annotations = [...batch.annotations].sort(
    (left, right) =>
      Number(owners.has(right.conversationId)) -
      Number(owners.has(left.conversationId)),
  );
  const first = MAX_CONVERSATION_CHANGES - batch.inboxItems.length;
  await changes.apply({
    annotations: annotations.slice(0, first),
    inboxItems: batch.inboxItems,
  });
  for (
    let start = first;
    start < annotations.length;
    start += MAX_CONVERSATION_CHANGES
  ) {
    // oxlint-disable-next-line no-await-in-loop -- Batches are separate writes, saved in order.
    await changes.apply({
      annotations: annotations.slice(start, start + MAX_CONVERSATION_CHANGES),
    });
  }
}

/**
 * Record one pull request outcome. When the stored row changes, update the
 * code index. A merged or closed pull request then marks the chip of each
 * linked conversation and closes its Inbox items in one batch, so no reader
 * sees a merged chip next to an open item. The chips and items are optional
 * UI, so a failed batch is logged and does not stop the work after it.
 */
export async function applyGitHubPullRequestOutcome(args: {
  annotations: PluginConversationAnnotations;
  codeChanges: CodeChangePublisher;
  conversationChanges: PluginConversationChanges;
  db: GitHubDb;
  log?: Pick<PluginLogger, "error" | "warn"> | undefined;
  outcome: GitHubPullRequestOutcomeInput;
}): Promise<Awaited<ReturnType<typeof recordGitHubPullRequestOutcome>>> {
  const { outcome } = args;
  const recorded = await recordGitHubPullRequestOutcome(args.db, outcome);
  if (!recorded.applied) return recorded;
  await args.codeChanges.record(
    githubCodeChange(outcome, recorded.conversationIds),
  );
  if (outcome.state !== "open") {
    const state = outcome.state === "merged" ? "merged" : "closed";
    try {
      const [inboxItems, annotations] = await Promise.all([
        endedGitHubPullRequestItemChanges({
          db: args.db,
          state,
          target: outcome,
        }),
        githubAnnotationChanges({
          annotations: args.annotations,
          conversationIds: recorded.conversationIds,
          update: {
            repo: outcome.repositoryFullName,
            number: outcome.number,
            objectType: "code_change",
            status: state,
          },
        }),
      ]);
      await applyEndedChanges(args.conversationChanges, {
        annotations,
        inboxItems,
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
  return recorded;
}
