/**
 * The one write path for a pull request lifecycle outcome. The webhook and
 * the daily reconcile both use it, so the stored row, Junior's code index,
 * and the conversation chip change together.
 */
import type {
  CodeChangeInput,
  CodeChangePublisher,
  PluginConversationAnnotations,
  PluginLogger,
} from "@sentry/junior-plugin-api";
import { updateGitHubAnnotations } from "../annotations.js";
import type { GitHubDb } from "../db/database.js";
import {
  type GitHubPullRequestOutcomeInput,
  recordGitHubPullRequestOutcome,
} from "./store.js";

function githubCodeChange(
  outcome: GitHubPullRequestOutcomeInput,
  conversationIds: string[],
): CodeChangeInput {
  return {
    closedAt: outcome.closedAt,
    conversationIds,
    mergedAt: outcome.mergedAt,
    number: outcome.number,
    openedAt: outcome.openedAt,
    providerId: outcome.pullRequestId,
    repository: {
      name: outcome.repositoryFullName,
      providerId: outcome.repositoryId,
      url: `https://github.com/${outcome.repositoryFullName}`,
    },
    state: outcome.state === "closed_unmerged" ? "closed" : outcome.state,
    title: outcome.title,
    updatedAt: outcome.updatedAt,
    url: `https://github.com/${outcome.repositoryFullName}/pull/${outcome.number}`,
  };
}

/**
 * Record one pull request outcome. When the stored row changes, update the
 * code index, and mark the chip of each linked conversation merged or closed.
 * A failed chip is logged, so it does not stop the work after it.
 */
export async function applyGitHubPullRequestOutcome(args: {
  annotations: PluginConversationAnnotations;
  codeChanges: CodeChangePublisher;
  db: GitHubDb;
  log?: Pick<PluginLogger, "error">;
  outcome: GitHubPullRequestOutcomeInput;
}): Promise<Awaited<ReturnType<typeof recordGitHubPullRequestOutcome>>> {
  const { outcome } = args;
  const recorded = await recordGitHubPullRequestOutcome(args.db, outcome);
  if (!recorded.applied) return recorded;
  await args.codeChanges.record(
    githubCodeChange(outcome, recorded.conversationIds),
  );
  if (outcome.state !== "open") {
    await updateGitHubAnnotations({
      annotations: args.annotations,
      conversationIds: recorded.conversationIds,
      log: args.log,
      update: {
        repo: outcome.repositoryFullName,
        number: outcome.number,
        objectType: "code_change",
        status: outcome.state === "merged" ? "merged" : "closed",
      },
    });
  }
  return recorded;
}
