/**
 * When a merge conflict wakes Junior. A fix is a full agent turn, so only a
 * Junior pull request that people still work on gets one:
 *
 * - A draft gets nothing.
 * - In the first 2 days after the latest activity by a person, Junior fixes
 *   the conflict, at most once a day, and at most 3 times in a row with no
 *   activity by a person between them.
 * - After that, a conflict does nothing, and nobody is told. The next
 *   activity by a person starts the fixes again.
 * - An approved pull request would be ready to merge but for the conflict,
 *   so it gets a fix after the 2 days too, and without the daily wait. The
 *   ready to merge notice needs a clean merge state, so it waits for the
 *   fix. The limit of fixes in a row still holds.
 * - When a day after its fix the head commit is the same, the fix did not
 *   land, and Junior is stuck. Then it asks the person who asked for the
 *   pull request to resume, on the pull request's Inbox item
 *   (`webhooks/pull-request-item.ts`), once after each Resume. So Dismiss
 *   ends the asks on the pull request. Resume counts as activity by a
 *   person, and starts a fix at once (`resume.ts`).
 *
 * Each conflict reads the pull request's history from GitHub for the latest
 * activity by a person. Opening the pull request counts as activity,
 * because a person asked for it. Only the fixes that this policy or Resume
 * started count as fixes, so a merge or force push for work that a person
 * asked for does not. The plugin stores them with the time of the latest
 * Resume and of the latest ask. The event key names the head commit, so a
 * check of the same commit, or a webhook and the heartbeat at once, publish
 * one fix. A conflict on a pull request that Junior did not open goes to its
 * Watch as before, except for a draft.
 */
import type { EventInput, PluginLogger } from "@sentry/junior-plugin-api";
import { and, eq } from "drizzle-orm";
import * as z from "zod";
import type { GitHubDb } from "../db/database.js";
import {
  type GitHubConflictFix,
  juniorGitHubPullRequests,
} from "../db/schema.js";
import { pullRequestRow } from "../pull-request-outcomes/store.js";
import { logFailOpenFailure } from "../webhooks/fail-open-log.js";
import type {
  GitHubMergeConflict,
  GitHubPullRequestRef,
} from "../webhooks/merge-conflict.js";

const DAY_MS = 24 * 60 * 60_000;

/** Time after activity by a person in which Junior fixes conflicts. */
const ACTIVE_MS = 2 * DAY_MS;

/** Shortest time between two fixes of one pull request. */
const FIX_INTERVAL_MS = DAY_MS;

/** Fixes in a row, with no activity by a person, before Junior waits. */
const MAX_FIXES = 3;

/** The choice of the merge conflict ask that resumes the fixes. */
export const GITHUB_CONFLICT_RESUME = "Resume";

const actorSchema = z.object({ __typename: z.string() }).nullable();

const timelineItemSchema = z.union([
  z.object({
    __typename: z.literal("PullRequestCommit"),
    commit: z.object({
      author: z
        .object({ user: z.object({ login: z.string() }).nullable() })
        .nullable(),
      committedDate: z.string(),
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

/** What GitHub says about the people on one pull request. */
interface GitHubConflictHistory {
  /** The latest push, review, or comment by a person, or the opening. */
  activeAtMs: number;
  approved: boolean;
}

/**
 * Read the history from GitHub's answer. A deleted account has no author,
 * and counts as a person. Activity by a bot is not activity.
 */
function parseGitHubConflictHistory(response: unknown): GitHubConflictHistory {
  const pullRequest =
    historyResponseSchema.parse(response).data.repository.pullRequest;
  let activeAtMs = Date.parse(pullRequest.createdAt);
  const record = (bot: boolean, at: string | null) => {
    if (!bot && at) activeAtMs = Math.max(activeAtMs, Date.parse(at));
  };
  for (const item of [
    ...pullRequest.pushes.nodes,
    ...pullRequest.discussion.nodes,
  ]) {
    if (!item) continue;
    switch (item.__typename) {
      case "PullRequestCommit":
        record(
          item.commit.author?.user?.login?.endsWith("[bot]") === true,
          item.commit.committedDate,
        );
        break;
      case "HeadRefForcePushedEvent":
        record(item.actor?.__typename === "Bot", item.createdAt);
        break;
      case "PullRequestReview":
        record(item.author?.__typename === "Bot", item.submittedAt);
        break;
      case "IssueComment":
        record(item.author?.__typename === "Bot", item.createdAt);
        break;
    }
  }
  return {
    activeAtMs,
    approved: pullRequest.reviewDecision === "APPROVED",
  };
}

/**
 * Add a fix that Junior started to the stored fixes. A second fix of one
 * head commit replaces the first. Only the latest `MAX_FIXES` matter.
 */
export function withGitHubConflictFix(
  fixes: GitHubConflictFix[],
  fix: GitHubConflictFix,
): GitHubConflictFix[] {
  return [...fixes.filter(({ headSha }) => headSha !== fix.headSha), fix].slice(
    -MAX_FIXES,
  );
}

/**
 * `retry` publishes a fix that started already again. `ask` adds the Review
 * item for a fix that did not land.
 */
type GitHubConflictAction = "ask" | "fix" | "retry" | "skip";

/** Decide what a conflict on one open Junior pull request does. */
function gitHubConflictAction(input: {
  askedAtMs: number | undefined;
  fixes: GitHubConflictFix[];
  headSha: string;
  history: GitHubConflictHistory;
  nowMs: number;
  resumedAtMs: number | undefined;
}): GitHubConflictAction {
  const { askedAtMs, fixes, nowMs, resumedAtMs } = input;
  const { approved } = input.history;
  // A Resume counts as activity by a person.
  const activeAtMs = Math.max(input.history.activeAtMs, resumedAtMs ?? 0);
  // Upkeep follows people: an idle pull request gets no fix and no ask.
  if (nowMs - activeAtMs > ACTIVE_MS && !approved) return "skip";
  // A Resume that has not saved its fix yet is starting one.
  const resuming =
    resumedAtMs === activeAtMs && fixes.every(({ atMs }) => atMs < resumedAtMs);
  const started = resuming
    ? resumedAtMs
    : fixes.find(({ headSha }) => headSha === input.headSha)?.atMs;
  if (started !== undefined) {
    // A fix changes the head commit. So with the same head a day later, the
    // fix did not land. Ask once after each Resume, so Dismiss ends the
    // asks.
    if (nowMs - started >= FIX_INTERVAL_MS) {
      return askedAtMs !== undefined && askedAtMs > (resumedAtMs ?? 0)
        ? "skip"
        : "ask";
    }
    // The policy's event key names the head commit, and core delivers each
    // key once, so its event publishes again: a publish that failed gets
    // another try. A Resume's event has its own key.
    return resuming || started === resumedAtMs ? "skip" : "retry";
  }
  // The fix that Resume started counts as the first in a row. The next
  // activity by a person starts the count again.
  if (fixes.filter(({ atMs }) => atMs >= activeAtMs).length >= MAX_FIXES) {
    return "skip";
  }
  // Only a pull request that is not approved waits a day between fixes.
  const fixedAtMs = Math.max(
    resumedAtMs ?? 0,
    ...fixes.map(({ atMs }) => atMs),
  );
  return !approved && nowMs - fixedAtMs < FIX_INTERVAL_MS ? "skip" : "fix";
}

/**
 * Return the merge conflict events to publish for one conflicted pull
 * request that a Watch or event automation wants. A fix returns `events`.
 * An ask adds the Inbox item and returns no events. The item is optional,
 * so a failure is logged, and the next check tries again.
 */
export async function applyGitHubConflictPolicy(args: {
  conflict: GitHubMergeConflict;
  db: GitHubDb;
  draft: boolean;
  events: EventInput[];
  /** Read the pull request's `PULL_REQUEST_CONFLICT_HISTORY` from GitHub. */
  loadHistory(ref: GitHubPullRequestRef): Promise<unknown>;
  log?: Pick<PluginLogger, "error" | "warn"> | undefined;
  now: Date;
  ref: GitHubPullRequestRef;
  /**
   * Change the pull request's item after an ask is saved, so the requester
   * joins it. Throws when the item fails.
   */
  showItem(ref: GitHubPullRequestRef): Promise<void>;
}): Promise<EventInput[]> {
  if (args.draft) return [];
  const t = juniorGitHubPullRequests;
  const [row] = await args.db
    .select({
      askedAt: t.conflictFixAskedAt,
      fixes: t.conflictFixes,
      resumedAt: t.conflictFixesResumedAt,
    })
    .from(t)
    .where(and(pullRequestRow(args.ref), eq(t.state, "open")))
    .limit(1);
  if (!row) return args.events;
  const nowMs = args.now.getTime();
  const action = gitHubConflictAction({
    askedAtMs: row.askedAt?.getTime(),
    fixes: row.fixes,
    headSha: args.conflict.headSha,
    history: parseGitHubConflictHistory(await args.loadHistory(args.ref)),
    nowMs,
    resumedAtMs: row.resumedAt?.getTime(),
  });
  if (action === "skip") return [];
  if (action === "retry") return args.events;
  if (action === "fix") {
    await args.db
      .update(t)
      .set({
        conflictFixes: withGitHubConflictFix(row.fixes, {
          atMs: nowMs,
          headSha: args.conflict.headSha,
        }),
      })
      .where(pullRequestRow(args.ref));
    return args.events;
  }
  // The item reads the saved ask. A failed item undoes it, so the next check
  // asks again.
  await args.db
    .update(t)
    .set({ conflictFixAskedAt: args.now })
    .where(pullRequestRow(args.ref));
  try {
    await args.showItem(args.ref);
  } catch (error) {
    await args.db
      .update(t)
      .set({ conflictFixAskedAt: row.askedAt })
      .where(and(pullRequestRow(args.ref), eq(t.conflictFixAskedAt, args.now)));
    logFailOpenFailure(args.log, "GitHub merge conflict item failed", error, {
      number: args.ref.number,
      repository: args.ref.repositoryFullName,
    });
  }
  return [];
}
