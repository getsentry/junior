/**
 * The heartbeat part of merge conflict checks. For each due repository, a
 * GraphQL search reads the open Junior pull requests with their
 * mergeability. Only a conflicted Junior pull request also reads its
 * history. Only a conflict that a Watch or event automation wants, and that
 * `policy.ts` allows, publishes `pull_request.merge_conflict`. No agent runs
 * for the check.
 */
import type {
  EventPublisher,
  PluginLogger,
  PluginState,
} from "@sentry/junior-plugin-api";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import * as z from "zod";
import type { GitHubDb } from "../db/database.js";
import { juniorGitHubPullRequests } from "../db/schema.js";
import { logFailOpenFailure } from "../webhooks/fail-open-log.js";
import {
  gitHubMergeConflictEvents,
  type GitHubMergeConflict,
  type GitHubPullRequestRef,
} from "../webhooks/merge-conflict.js";
import { applyGitHubConflictPolicy } from "./policy.js";
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
    state: z.string(),
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
  after?: string | undefined;
  repositoryFullName: string;
}) => Promise<unknown>;

/** Return whether any open pull request still has an unknown answer. */
/** Apply the conflict policy to one pull request and publish its events. */
async function checkConflict(
  args: CheckArgs,
  input: {
    conflict: GitHubMergeConflict;
    draft: boolean;
    ref: { number: number; repositoryFullName: string };
  },
): Promise<void> {
  const events = gitHubMergeConflictEvents({
    ...input.ref,
    conflict: input.conflict,
  });
  // Conflict events match only `repo` and `pullRequest`.
  if (!(await args.events.hasMatch?.(events))) return;
  for (const event of await applyGitHubConflictPolicy({
    conflict: input.conflict,
    db: args.db,
    draft: input.draft,
    events,
    loadHistory: args.loadHistory,
    log: args.log,
    now: args.now,
    ref: input.ref,
    showItem: async (ref) =>
      await args.showItem({ ...ref, conflictAsked: true }),
  })) {
    // oxlint-disable-next-line no-await-in-loop -- Publish in order, so watchers see events in the order they happened.
    await args.events.publish(event);
  }
}

async function checkRepository(
  args: CheckArgs,
  repositoryFullName: string,
): Promise<boolean> {
  let unknown = false;
  let after: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const { search } = searchResponseSchema.parse(
      // oxlint-disable-next-line no-await-in-loop -- Each page needs the cursor from the page before.
      await args.search({ after, repositoryFullName }),
    ).data;
    const mergeable: number[] = [];
    for (const node of search.nodes) {
      if (!node || !("number" in node) || node.state !== "OPEN") continue;
      if (node.mergeable === "UNKNOWN") unknown = true;
      if (node.mergeable === "MERGEABLE") mergeable.push(node.number);
      if (node.mergeable !== "CONFLICTING") continue;
      const ref = { number: node.number, repositoryFullName };
      const conflict: GitHubMergeConflict = {
        baseBranch: node.baseRefName,
        headSha: node.headRefOid,
        url: node.url,
      };
      // oxlint-disable-next-line no-await-in-loop -- The sweep checks one pull request at a time, under GitHub rate limits.
      await checkConflict(args, {
        conflict,
        draft: node.isDraft,
        ref,
      });
    }
    // oxlint-disable-next-line no-await-in-loop -- Each page needs the cursor from the page before.
    await showResolvedConflicts(args, repositoryFullName, mergeable);
    if (!search.pageInfo.hasNextPage || !search.pageInfo.endCursor) break;
    after = search.pageInfo.endCursor;
  }
  return unknown;
}

/**
 * Change the item of each mergeable pull request that still has a merge
 * conflict ask, so the ask leaves it. A failed item is logged, and the next
 * check tries again.
 */
async function showResolvedConflicts(
  args: CheckArgs,
  repositoryFullName: string,
  numbers: number[],
): Promise<void> {
  if (numbers.length === 0) return;
  const t = juniorGitHubPullRequests;
  const asked = await args.db
    .select({ number: t.number })
    .from(t)
    .where(
      and(
        eq(t.repositoryFullName, repositoryFullName),
        inArray(t.number, numbers),
        isNotNull(t.conflictFixAskedAt),
      ),
    );
  for (const { number } of asked) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- The sweep reads one pull request at a time, under GitHub rate limits.
      await args.showItem({ number, repositoryFullName });
    } catch (error) {
      logFailOpenFailure(
        args.log,
        "GitHub merge conflict ask change failed",
        error,
        { number, repository: repositoryFullName },
      );
    }
  }
}

interface CheckArgs {
  db: GitHubDb;
  events: EventPublisher;
  loadHistory(ref: GitHubPullRequestRef): Promise<unknown>;
  log: Pick<PluginLogger, "error" | "warn">;
  now: Date;
  search: SearchOpenPullRequests;
  /**
   * Read one pull request from GitHub and change its Inbox item. Throws
   * when it fails.
   */
  showItem(
    target: GitHubPullRequestRef & { conflictAsked?: boolean },
  ): Promise<void>;
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
    args.log.error(
      "GitHub merge conflict check failed",
      {
        attempts: check.attempts,
        errorType: error instanceof Error ? error.name : "UnknownError",
        repository: check.repositoryFullName,
      },
      error,
    );
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
    // oxlint-disable-next-line no-await-in-loop -- Claim and check one repository at a time, up to CHECK_LIMIT.
    const check = await claimGitHubConflictCheck({
      claimedUntilMs: nowMs + CLAIM_MS,
      nowMs,
      repositoryFullName,
      state: args.state,
    });
    if (!check) continue;
    checked += 1;
    // oxlint-disable-next-line no-await-in-loop -- Claim and check one repository at a time, up to CHECK_LIMIT.
    await runCheck(args, check);
  }
}
