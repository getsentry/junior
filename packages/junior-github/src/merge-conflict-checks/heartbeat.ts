/**
 * The heartbeat part of merge conflict checks. For each due repository, one
 * GraphQL request reads the mergeability of the open Junior pull requests.
 * Only a conflict that a Watch or event automation wants publishes
 * `pull_request.merge_conflict`. No agent runs for the check.
 */
import type { EventPublisher, PluginLogger } from "@sentry/junior-plugin-api";
import * as z from "zod";
import type { GitHubDb } from "../db/database.js";
import { gitHubMergeConflictEvents } from "../webhooks/merge-conflict.js";
import {
  claimGitHubConflictChecks,
  listOpenGitHubPullRequestNumbers,
  settleGitHubConflictCheck,
  type GitHubConflictCheck,
} from "./store.js";
import { CONFLICT_CHECK_DELAY_MS } from "./webhooks.js";

/** Repositories per heartbeat. */
const CHECK_LIMIT = 10;

/** Pull requests per GraphQL request. */
const PULL_REQUESTS_PER_REQUEST = 50;

/**
 * A claimed check that stops without an end runs again after this time. It
 * must be longer than `CONFLICT_CHECK_DELAY_MS`, so a push during a check
 * moves the claim earlier and the check does not remove the new one.
 */
const CLAIM_MS = 3 * CONFLICT_CHECK_DELAY_MS;

/** Time to wait for GitHub to calculate mergeability. */
const UNKNOWN_RETRY_MS = 60_000;

/**
 * Attempts before a check stops. An unknown answer or a failed read uses
 * one attempt. A new push starts the count again.
 */
const MAX_ATTEMPTS = 5;

/** One pull request in the GraphQL answer. Missing pull requests are null. */
const pullRequestSchema = z.object({
  baseRefName: z.string().min(1),
  headRefOid: z.string().min(1),
  mergeable: z.enum(["CONFLICTING", "MERGEABLE", "UNKNOWN"]),
  number: z.number().int().positive(),
  state: z.string(),
  url: z.string().min(1),
});

const mergeabilityResponseSchema = z.object({
  data: z.object({
    repository: z.record(z.string(), pullRequestSchema.nullable()),
  }),
});

type LoadMergeability = (input: {
  numbers: number[];
  repositoryFullName: string;
}) => Promise<unknown>;

/** Return whether any open pull request still has an unknown answer. */
async function checkRepository(
  args: { events: EventPublisher; loadMergeability: LoadMergeability },
  repositoryFullName: string,
  numbers: number[],
): Promise<boolean> {
  let unknown = false;
  for (let i = 0; i < numbers.length; i += PULL_REQUESTS_PER_REQUEST) {
    const response = mergeabilityResponseSchema.parse(
      await args.loadMergeability({
        numbers: numbers.slice(i, i + PULL_REQUESTS_PER_REQUEST),
        repositoryFullName,
      }),
    );
    for (const pullRequest of Object.values(response.data.repository)) {
      if (pullRequest?.state !== "OPEN") continue;
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
  }
  return unknown;
}

async function runCheck(
  args: {
    db: GitHubDb;
    events: EventPublisher;
    loadMergeability: LoadMergeability;
    log: Pick<PluginLogger, "error">;
    now: Date;
  },
  check: GitHubConflictCheck,
): Promise<void> {
  const numbers = await listOpenGitHubPullRequestNumbers(
    args.db,
    check.repositoryFullName,
  );
  let unknown: boolean;
  try {
    unknown = await checkRepository(args, check.repositoryFullName, numbers);
  } catch (error) {
    args.log.error("GitHub merge conflict check failed", {
      attempts: check.attempts,
      errorType: error instanceof Error ? error.name : "UnknownError",
      repository: check.repositoryFullName,
    });
    // Keep the claim, so the check runs again when the claim ends.
    if (check.attempts >= MAX_ATTEMPTS) {
      await settleGitHubConflictCheck(args.db, check);
    }
    return;
  }
  await settleGitHubConflictCheck(
    args.db,
    check,
    unknown && check.attempts < MAX_ATTEMPTS
      ? new Date(args.now.getTime() + UNKNOWN_RETRY_MS)
      : undefined,
  );
}

/** Run the merge conflict checks that are due. */
export async function runGitHubConflictChecks(args: {
  db: GitHubDb;
  events: EventPublisher;
  loadMergeability: LoadMergeability;
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
