/**
 * The heartbeat part of merge conflict checks. For each due repository, a
 * GraphQL search reads the open Junior pull requests with their
 * mergeability.
 * Only a conflict that a Watch or event automation wants publishes
 * `pull_request.merge_conflict`. No agent runs for the check.
 */
import type {
  EventPublisher,
  PluginLogger,
  PluginState,
} from "@sentry/junior-plugin-api";
import type { GitHubDb } from "../db/database.js";
import {
  listOpenGitHubPullRequests,
  type SearchOpenPullRequests,
} from "../open-pull-requests.js";
import { gitHubMergeConflictEvents } from "../webhooks/merge-conflict.js";
import {
  claimGitHubConflictCheck,
  listGitHubRepositoriesWithOpenPullRequests,
  settleGitHubConflictCheck,
  type GitHubConflictCheck,
} from "./store.js";

/** Repositories per heartbeat. */
const CHECK_LIMIT = 10;

/** A claimed check that stops without an end runs again after this time. */
const CLAIM_MS = 5 * 60_000;

/** Time to wait for GitHub to calculate mergeability. */
const UNKNOWN_RETRY_MS = 60_000;

/**
 * Attempts before a check stops. An unknown answer or a failed read uses
 * one attempt. A new push starts the count again.
 */
const MAX_ATTEMPTS = 5;

/** Return whether any open pull request still has an unknown answer. */
async function checkRepository(
  args: { events: EventPublisher; search: SearchOpenPullRequests },
  repositoryFullName: string,
): Promise<boolean> {
  let unknown = false;
  for (const pullRequest of await listOpenGitHubPullRequests(
    args.search,
    repositoryFullName,
  )) {
    if (pullRequest.mergeable === "UNKNOWN") unknown = true;
    if (pullRequest.mergeable !== "CONFLICTING") continue;
    const events = gitHubMergeConflictEvents({
      conflict: {
        baseBranch: pullRequest.baseRefName,
        headSha: pullRequest.headRefOid,
        url: pullRequest.url,
      },
      number: pullRequest.number,
      repositoryFullName,
    });
    // Conflict events match only `repo` and `pullRequest`.
    if (!(await args.events.hasMatch?.(events))) continue;
    for (const event of events) await args.events.publish(event);
  }
  return unknown;
}

interface CheckArgs {
  db: GitHubDb;
  events: EventPublisher;
  log: Pick<PluginLogger, "error">;
  now: Date;
  search: SearchOpenPullRequests;
  state: PluginState;
}

async function runCheck(
  args: CheckArgs,
  check: GitHubConflictCheck,
): Promise<void> {
  let unknown: boolean;
  try {
    unknown = await checkRepository(args, check.repositoryFullName);
  } catch (error) {
    args.log.error("GitHub merge conflict check failed", {
      attempts: check.attempts,
      errorType: error instanceof Error ? error.name : "UnknownError",
      repository: check.repositoryFullName,
    });
    // Keep the claim, so the check runs again when the claim ends.
    if (check.attempts >= MAX_ATTEMPTS) {
      await settleGitHubConflictCheck(args.state, check);
    }
    return;
  }
  await settleGitHubConflictCheck(
    args.state,
    check,
    unknown && check.attempts < MAX_ATTEMPTS
      ? args.now.getTime() + UNKNOWN_RETRY_MS
      : undefined,
  );
}

/**
 * Run the merge conflict checks that are due. Only a repository with open
 * Junior pull requests can have a check.
 */
export async function runGitHubConflictChecks(args: CheckArgs): Promise<void> {
  const nowMs = args.now.getTime();
  let checked = 0;
  for (const repositoryFullName of await listGitHubRepositoriesWithOpenPullRequests(
    args.db,
  )) {
    if (checked >= CHECK_LIMIT) break;
    const check = await claimGitHubConflictCheck({
      claimedUntilMs: nowMs + CLAIM_MS,
      nowMs,
      repositoryFullName,
      state: args.state,
    });
    if (!check) continue;
    checked += 1;
    await runCheck(args, check);
  }
}
