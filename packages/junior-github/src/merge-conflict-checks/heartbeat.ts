/**
 * The heartbeat part of merge conflict checks. For each due repository, a
 * GraphQL search reads the open Junior pull requests with their
 * mergeability.
 * Only a conflict that a Watch or event automation wants, and that
 * `policy.ts` allows, publishes `pull_request.merge_conflict`. No agent runs
 * for the check.
 */
import type {
  EventPublisher,
  PluginConversationReviewItems,
  PluginLogger,
  PluginState,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import type { GitHubDb } from "../db/database.js";
import {
  gitHubMergeConflictEvents,
  type GitHubMergeConflict,
} from "../webhooks/merge-conflict.js";
import {
  applyGitHubConflictPolicy,
  closeGitHubConflictNotice,
} from "./policy.js";
import {
  claimGitHubConflictCheck,
  listGitHubRepositoriesWithOpenPullRequests,
  settleGitHubConflictCheck,
  type GitHubConflictCheck,
} from "./store.js";

/** Repositories per heartbeat. */
const CHECK_LIMIT = 10;

/** Search pages per check, at 100 pull requests per page. */
const MAX_PAGES = 5;

/** A claimed check that stops without an end runs again after this time. */
const CLAIM_MS = 5 * 60_000;

/** Time to wait for GitHub to calculate mergeability. */
const UNKNOWN_RETRY_MS = 60_000;

/**
 * Attempts before a check stops. An unknown answer or a failed read uses
 * one attempt. A new push starts the count again.
 */
const MAX_ATTEMPTS = 5;

/** One search result. A result that is not a pull request has no fields. */
const searchNodeSchema = z.union([
  z.object({
    baseRefName: z.string().min(1),
    headRefOid: z.string().min(1),
    isDraft: z.boolean(),
    mergeable: z.enum(["CONFLICTING", "MERGEABLE", "UNKNOWN"]),
    number: z.number().int().positive(),
    reviewDecision: z.string().nullable(),
    state: z.string(),
    title: z.string(),
    url: z.string().min(1),
  }),
  z.object({}).strict(),
]);

const searchResponseSchema = z.object({
  data: z.object({
    search: z.object({
      nodes: z.array(searchNodeSchema.nullable()),
      pageInfo: z.object({
        endCursor: z.string().nullable(),
        hasNextPage: z.boolean(),
      }),
    }),
  }),
});

type SearchOpenPullRequests = (input: {
  after?: string;
  repositoryFullName: string;
}) => Promise<unknown>;

/** Return whether any open pull request still has an unknown answer. */
async function checkRepository(
  args: CheckArgs,
  repositoryFullName: string,
): Promise<boolean> {
  let unknown = false;
  let after: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const { search } = searchResponseSchema.parse(
      await args.search({ after, repositoryFullName }),
    ).data;
    for (const node of search.nodes) {
      if (!node || !("number" in node) || node.state !== "OPEN") continue;
      if (node.mergeable === "UNKNOWN") unknown = true;
      const ref = { number: node.number, repositoryFullName };
      if (node.mergeable === "MERGEABLE") {
        await closeGitHubConflictNotice({
          db: args.db,
          log: args.log,
          ref,
          reviewItems: args.reviewItems,
        });
      }
      if (node.mergeable !== "CONFLICTING") continue;
      const conflict: GitHubMergeConflict = {
        baseBranch: node.baseRefName,
        headSha: node.headRefOid,
        url: node.url,
      };
      const events = gitHubMergeConflictEvents({ ...ref, conflict });
      // Conflict events match only `repo` and `pullRequest`.
      if (!(await args.events.hasMatch?.(events))) continue;
      for (const event of await applyGitHubConflictPolicy({
        approved: node.reviewDecision === "APPROVED",
        conflict,
        db: args.db,
        draft: node.isDraft,
        events,
        log: args.log,
        now: args.now,
        ref,
        reviewItems: args.reviewItems,
        title: node.title,
      })) {
        await args.events.publish(event);
      }
    }
    if (!search.pageInfo.hasNextPage || !search.pageInfo.endCursor) break;
    after = search.pageInfo.endCursor;
  }
  return unknown;
}

interface CheckArgs {
  db: GitHubDb;
  events: EventPublisher;
  log: Pick<PluginLogger, "error" | "warn">;
  now: Date;
  reviewItems: PluginConversationReviewItems;
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
