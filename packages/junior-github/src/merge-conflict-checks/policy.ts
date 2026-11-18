/**
 * When a merge conflict wakes Junior. A fix is a full agent turn, so only a
 * Junior pull request that people still work on gets one:
 *
 * - A draft gets nothing.
 * - In the first 2 days after the latest activity by a person, Junior fixes
 *   the conflict, at most once a day, and at most 3 times in a row with no
 *   activity by a person between them.
 * - After that, nothing.
 * - An approved pull request would be ready to merge but for the conflict,
 *   so it gets a fix after the 2 days too, and without the daily wait. The
 *   ready to merge notice needs a clean merge state, so it waits for the
 *   fix. The limit of fixes in a row still holds.
 *
 * Junior keeps no state for this. Each conflict reads the pull request's
 * history from GitHub. Opening the pull request counts as activity, because
 * a person asked for it. Merges and force pushes by a bot after the latest
 * activity by a person count as fixes. The event key names the head commit,
 * so a check of the same commit, or a webhook and the heartbeat at once,
 * publish one fix. A conflict on a pull request that Junior did not open
 * goes to its Watch as before, except for a draft.
 */
import type { EventInput } from "@sentry/junior-plugin-api";
import { and, eq } from "drizzle-orm";
import * as z from "zod";
import type { GitHubDb } from "../db/database.js";
import { juniorGitHubPullRequests } from "../db/schema.js";
import { pullRequestRow } from "../pull-request-outcomes/store.js";
import type { GitHubPullRequestRef } from "../webhooks/merge-conflict.js";

const DAY_MS = 24 * 60 * 60_000;

/** Time after activity by a person in which Junior fixes conflicts. */
const ACTIVE_MS = 2 * DAY_MS;

/** Shortest time between two fixes of one pull request. */
const FIX_INTERVAL_MS = DAY_MS;

/** Fixes in a row, with no activity by a person, before Junior stops. */
const MAX_FIXES = 3;

const actorSchema = z.object({ __typename: z.string() }).nullable();

const timelineItemSchema = z.union([
  z.object({
    __typename: z.literal("PullRequestCommit"),
    commit: z.object({
      author: z
        .object({ user: z.object({ login: z.string() }).nullable() })
        .nullable(),
      committedDate: z.string(),
      parents: z.object({ totalCount: z.number() }),
    }),
  }),
  z.object({
    __typename: z.literal("PullRequestReview"),
    author: actorSchema,
    submittedAt: z.string().nullable(),
  }),
  z.object({
    __typename: z.literal("IssueComment"),
    author: actorSchema,
    createdAt: z.string(),
  }),
  z.object({
    __typename: z.literal("HeadRefForcePushedEvent"),
    actor: actorSchema,
    createdAt: z.string(),
  }),
]);

const historyResponseSchema = z.object({
  data: z.object({
    repository: z.object({
      pullRequest: z.object({
        createdAt: z.string(),
        discussion: z.object({
          nodes: z.array(timelineItemSchema.nullable()),
        }),
        pushes: z.object({
          nodes: z.array(timelineItemSchema.nullable()),
        }),
        reviewDecision: z.string().nullable(),
      }),
    }),
  }),
});

/** What GitHub says about the people and the fixes on one pull request. */
interface GitHubConflictHistory {
  /** The latest push, review, or comment by a person, or the opening. */
  activeAtMs: number;
  approved: boolean;
  /** The latest fix. */
  fixedAtMs?: number;
  /** Fixes after `activeAtMs`. */
  fixes: number;
}

/**
 * Read the history from GitHub's answer. A deleted account has no author,
 * and counts as a person.
 */
function parseGitHubConflictHistory(response: unknown): GitHubConflictHistory {
  const pullRequest =
    historyResponseSchema.parse(response).data.repository.pullRequest;
  let activeAtMs = Date.parse(pullRequest.createdAt);
  const fixedAtMs: number[] = [];
  const record = (bot: boolean, fix: boolean, at: string | null) => {
    if (!at) return;
    const atMs = Date.parse(at);
    if (!bot) {
      activeAtMs = Math.max(activeAtMs, atMs);
    } else if (fix) {
      fixedAtMs.push(atMs);
    }
  };
  for (const item of [
    ...pullRequest.pushes.nodes,
    ...pullRequest.discussion.nodes,
  ]) {
    if (!item) continue;
    switch (item.__typename) {
      case "PullRequestCommit": {
        const login = item.commit.author?.user?.login;
        record(
          login?.endsWith("[bot]") === true,
          item.commit.parents.totalCount > 1,
          item.commit.committedDate,
        );
        break;
      }
      case "HeadRefForcePushedEvent":
        record(item.actor?.__typename === "Bot", true, item.createdAt);
        break;
      case "PullRequestReview":
        record(item.author?.__typename === "Bot", false, item.submittedAt);
        break;
      case "IssueComment":
        record(item.author?.__typename === "Bot", false, item.createdAt);
        break;
    }
  }
  // A bot also merges the base branch and force-pushes while it does work
  // that a person asked for, and the timeline cannot tell that from a
  // conflict fix. Activity by a person starts the count again, so a pull
  // request that people work on keeps getting fixes.
  return {
    activeAtMs,
    approved: pullRequest.reviewDecision === "APPROVED",
    fixes: fixedAtMs.filter((atMs) => atMs > activeAtMs).length,
    ...(fixedAtMs.length ? { fixedAtMs: Math.max(...fixedAtMs) } : undefined),
  };
}

/** Return whether a conflict on one open Junior pull request gets a fix. */
function shouldFixGitHubConflict(
  history: GitHubConflictHistory,
  nowMs: number,
): boolean {
  const { approved, fixedAtMs } = history;
  if (nowMs - history.activeAtMs > ACTIVE_MS && !approved) return false;
  if (history.fixes >= MAX_FIXES) return false;
  return (
    approved || fixedAtMs === undefined || nowMs - fixedAtMs >= FIX_INTERVAL_MS
  );
}

/**
 * Return the merge conflict events to publish for one conflicted pull
 * request that a Watch or event automation wants. A Junior pull request
 * returns them only when the policy allows a fix.
 */
export async function applyGitHubConflictPolicy(args: {
  db: GitHubDb;
  draft: boolean;
  events: EventInput[];
  /** Read the pull request's `PULL_REQUEST_CONFLICT_HISTORY` from GitHub. */
  loadHistory(ref: GitHubPullRequestRef): Promise<unknown>;
  now: Date;
  ref: GitHubPullRequestRef;
}): Promise<EventInput[]> {
  if (args.draft) return [];
  const t = juniorGitHubPullRequests;
  const [row] = await args.db
    .select({ pullRequestId: t.pullRequestId })
    .from(t)
    .where(and(pullRequestRow(args.ref), eq(t.state, "open")))
    .limit(1);
  if (!row) return args.events;
  const history = parseGitHubConflictHistory(await args.loadHistory(args.ref));
  return shouldFixGitHubConflict(history, args.now.getTime())
    ? args.events
    : [];
}
