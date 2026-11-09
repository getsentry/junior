/**
 * The heartbeat part of merge conflict checks. It reads GitHub only for a
 * marked pull request that a Watch or event automation wants
 * `pull_request.merge_conflict` for. No agent runs unless it publishes.
 */
import type { EventPublisher, PluginLogger } from "@sentry/junior-plugin-api";
import type { GitHubDb } from "../db/database.js";
import {
  gitHubMergeability,
  gitHubMergeConflictEvents,
  type GitHubMergeability,
  type GitHubPullRequestRef,
} from "../webhooks/merge-conflict.js";
import { CONFLICT_CHECK_DELAY_MS } from "./webhooks.js";
import {
  claimGitHubConflictChecks,
  settleGitHubConflictCheck,
  type GitHubConflictCheck,
} from "./store.js";

/** Checks per heartbeat. Each check makes at most one GitHub read. */
const CHECK_LIMIT = 20;

/**
 * A claimed check that stops without an end runs again after this time. It
 * must be longer than `CONFLICT_CHECK_DELAY_MS`, so a push during a check
 * moves the claim earlier and the check does not end the new mark.
 */
const CLAIM_MS = 3 * CONFLICT_CHECK_DELAY_MS;

/** Time to wait for GitHub to calculate mergeability. */
const UNKNOWN_RETRY_MS = 60_000;

/**
 * Attempts before a check stops. An unknown answer or a failed read
 * uses one attempt. A new push starts the count again.
 */
const MAX_ATTEMPTS = 5;

async function runCheck(
  args: {
    db: GitHubDb;
    events: EventPublisher;
    loadPullRequest(ref: GitHubPullRequestRef): Promise<unknown>;
    log: Pick<PluginLogger, "error">;
    now: Date;
  },
  check: GitHubConflictCheck,
): Promise<void> {
  const ref = {
    number: check.number,
    repositoryFullName: check.repositoryFullName,
  };
  // Conflict events match only `repo` and `pullRequest`, so this answer is
  // the same as for the full events.
  if (!(await args.events.hasMatch?.(gitHubMergeConflictEvents(ref)))) {
    await settleGitHubConflictCheck(args.db, check);
    return;
  }
  let mergeability: GitHubMergeability;
  try {
    mergeability = gitHubMergeability(await args.loadPullRequest(ref));
  } catch (error) {
    args.log.error("GitHub pull request merge conflict check failed", {
      attempts: check.attempts,
      errorType: error instanceof Error ? error.name : "UnknownError",
      pullRequest: check.number,
      repository: check.repositoryFullName,
    });
    // Keep the claim, so the check runs again when the claim ends.
    if (check.attempts >= MAX_ATTEMPTS) {
      await settleGitHubConflictCheck(args.db, check);
    }
    return;
  }
  if (mergeability.status === "unknown" && check.attempts < MAX_ATTEMPTS) {
    await settleGitHubConflictCheck(
      args.db,
      check,
      new Date(args.now.getTime() + UNKNOWN_RETRY_MS),
    );
    return;
  }
  if (mergeability.status === "conflict") {
    for (const event of gitHubMergeConflictEvents({
      ...ref,
      conflict: mergeability.conflict,
    })) {
      await args.events.publish(event);
    }
  }
  await settleGitHubConflictCheck(args.db, check);
}

/** Run the merge conflict checks that are due. */
export async function runGitHubConflictChecks(args: {
  db: GitHubDb;
  events: EventPublisher;
  loadPullRequest(ref: GitHubPullRequestRef): Promise<unknown>;
  log: Pick<PluginLogger, "error">;
  now: Date;
}): Promise<void> {
  const checks = await claimGitHubConflictChecks(args.db, {
    claimedUntil: new Date(args.now.getTime() + CLAIM_MS),
    limit: CHECK_LIMIT,
    now: args.now,
  });
  for (const check of checks) {
    await runCheck(args, check);
  }
}
