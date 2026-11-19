/**
 * When a merge conflict wakes Junior. A fix is a full agent turn, so only a
 * Junior pull request that people still work on gets one:
 *
 * - A draft gets nothing.
 * - In the first 2 days after the latest activity by a person, Junior fixes
 *   the conflict, at most once a day, and at most 3 times in a row with no
 *   activity by a person between them.
 * - After that, Junior stops, and asks the person who asked for the pull
 *   request to resume, with a review desk item. Resume counts as activity
 *   by a person, and starts a fix at once (`resume.ts`).
 * - After 3 days without activity by a person, nothing.
 * - An approved pull request would be ready to merge but for the conflict,
 *   so it gets a fix after the 2 days too, and without the daily wait. The
 *   ready to merge notice needs a clean merge state, so it waits for the
 *   fix. The limit of fixes in a row still holds.
 *
 * Each conflict reads the pull request's history from GitHub. Opening the
 * pull request counts as activity, because a person asked for it. Merges
 * and force pushes by a bot after the latest activity by a person count as
 * fixes. The only state is the time of the latest Resume. The event key
 * names the head commit, so a check of the same commit, or a webhook and
 * the heartbeat at once, publish one fix. A conflict on a pull request that
 * Junior did not open goes to its Watch as before, except for a draft.
 */
import type {
  EventInput,
  PluginConversationReviewItems,
  PluginLogger,
} from "@sentry/junior-plugin-api";
import { and, eq } from "drizzle-orm";
import pLimit from "p-limit";
import * as z from "zod";
import type { GitHubDb } from "../db/database.js";
import { juniorGitHubPullRequests } from "../db/schema.js";
import { pullRequestRow } from "../pull-request-outcomes/store.js";
import { listGitHubPullRequestOpeners } from "../pull-request-requesters/store.js";
import { logFailOpenFailure } from "../webhooks/fail-open-log.js";
import type {
  GitHubMergeConflict,
  GitHubPullRequestRef,
} from "../webhooks/merge-conflict.js";

// Items that one change closes at once.
const ITEM_CLOSE_CONCURRENCY = 8;

const DAY_MS = 24 * 60 * 60_000;

/** Time after activity by a person in which Junior fixes conflicts. */
const ACTIVE_MS = 2 * DAY_MS;

/** Time after activity by a person after which conflicts do nothing. */
const IDLE_MS = 3 * DAY_MS;

/** Shortest time between two fixes of one pull request. */
const FIX_INTERVAL_MS = DAY_MS;

/** Fixes in a row, with no activity by a person, before Junior stops. */
const MAX_FIXES = 3;

/** The choice of the stopped item that resumes the fixes. */
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
  /** The latest fix, or the latest Resume. */
  fixedAtMs?: number;
  /** Fixes after `activeAtMs`. */
  fixes: number;
  /** No fix landed after the latest Resume, so its fix may still run. */
  resumeRunning: boolean;
}

/**
 * Read the history from GitHub's answer. A deleted account has no author,
 * and counts as a person. A Resume counts as activity by a person, and as
 * the latest fix for the daily wait, because it starts one.
 */
function parseGitHubConflictHistory(
  response: unknown,
  resumedAtMs: number | undefined,
): GitHubConflictHistory {
  const pullRequest =
    historyResponseSchema.parse(response).data.repository.pullRequest;
  let activeAtMs = Math.max(
    Date.parse(pullRequest.createdAt),
    resumedAtMs ?? 0,
  );
  const fixedAtMs: number[] = resumedAtMs === undefined ? [] : [resumedAtMs];
  const fixes: number[] = [];
  const record = (bot: boolean, fix: boolean, at: string | null) => {
    if (!at) return;
    const atMs = Date.parse(at);
    if (!bot) {
      activeAtMs = Math.max(activeAtMs, atMs);
    } else if (fix) {
      fixes.push(atMs);
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
    fixes: fixes.filter((atMs) => atMs > activeAtMs).length,
    ...(fixedAtMs.length ? { fixedAtMs: Math.max(...fixedAtMs) } : undefined),
    resumeRunning:
      resumedAtMs !== undefined && fixes.every((atMs) => atMs <= resumedAtMs),
  };
}

type GitHubConflictAction = "fix" | "stop" | "skip";

/** Decide what a conflict on one open Junior pull request does. */
function gitHubConflictAction(
  history: GitHubConflictHistory,
  nowMs: number,
): GitHubConflictAction {
  const { approved, fixedAtMs } = history;
  const idleMs = nowMs - history.activeAtMs;
  if (idleMs > IDLE_MS && !approved) return "skip";
  if ((idleMs <= ACTIVE_MS || approved) && history.fixes < MAX_FIXES) {
    // An approved pull request skips the daily wait, but not while the fix
    // that Resume started may still run.
    return (!approved || history.resumeRunning) &&
      fixedAtMs !== undefined &&
      nowMs - fixedAtMs < FIX_INTERVAL_MS
      ? "skip"
      : "fix";
  }
  return "stop";
}

const ITEM_KEY_PREFIX = "merge-conflict:";

/** The dedupe key of the stopped merge conflict item of one pull request. */
export function gitHubConflictItemKey(ref: GitHubPullRequestRef): string {
  return `${ITEM_KEY_PREFIX}${ref.repositoryFullName.toLowerCase()}#${ref.number}`;
}

/** Read the pull request of a stopped merge conflict item's dedupe key. */
export function parseGitHubConflictItemKey(
  dedupeKey: string,
): GitHubPullRequestRef | undefined {
  const match = /^([^/#\s]+\/[^/#\s]+)#(\d+)$/.exec(
    dedupeKey.startsWith(ITEM_KEY_PREFIX)
      ? dedupeKey.slice(ITEM_KEY_PREFIX.length)
      : "",
  );
  return match
    ? { number: Number(match[2]), repositoryFullName: match[1]! }
    : undefined;
}

async function addStoppedItem(
  args: {
    conflict: GitHubMergeConflict;
    db: GitHubDb;
    ref: GitHubPullRequestRef;
    reviewItems: PluginConversationReviewItems;
    title?: string;
  },
  fixes: number,
): Promise<void> {
  const { conflict, ref, title } = args;
  const opener = (
    await listGitHubPullRequestOpeners(args.db, {
      numbers: [ref.number],
      repositoryFullName: ref.repositoryFullName,
    })
  ).get(ref.number);
  // Only a pull request that a person asked for has a Conversation.
  if (!opener?.conversationId) return;
  const url =
    conflict.url ??
    `https://github.com/${ref.repositoryFullName}/pull/${ref.number}`;
  const reason =
    fixes >= MAX_FIXES
      ? `after ${fixes} in a row with no reply from a person`
      : "because nobody worked on it in the last 2 days";
  // An open item with the key only gets new content, so a check of a
  // conflict that has an item adds no second one.
  await args.reviewItems.forConversation(opener.conversationId).upsert({
    assigneeIdentityIds: [opener.identityId],
    body: `#${ref.number} conflicts with \`${conflict.baseBranch}\`. Fixes stopped ${reason}. Resume fixes it now and on later conflicts.`,
    choices: [{ label: GITHUB_CONFLICT_RESUME }],
    dedupeKey: gitHubConflictItemKey(ref),
    subject: {
      id: url,
      title: title ? `${title} (#${ref.number})` : url,
      url,
    },
    title: `Merge conflict · #${ref.number}`,
  });
}

/**
 * Return the merge conflict events to publish for one conflicted pull
 * request that a Watch or event automation wants. A fix returns `events`.
 * A stop adds the review desk item and returns no events. The item is
 * optional, so a failure is logged, and the next check tries again.
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
  reviewItems: PluginConversationReviewItems;
  title?: string;
}): Promise<EventInput[]> {
  if (args.draft) return [];
  const t = juniorGitHubPullRequests;
  const [row] = await args.db
    .select({ resumedAt: t.conflictFixesResumedAt })
    .from(t)
    .where(and(pullRequestRow(args.ref), eq(t.state, "open")))
    .limit(1);
  if (!row) return args.events;
  const history = parseGitHubConflictHistory(
    await args.loadHistory(args.ref),
    row.resumedAt?.getTime(),
  );
  const action = gitHubConflictAction(history, args.now.getTime());
  // A fix keeps an open item. Core delivers one fix per head commit, so a
  // fix of a head that Junior failed to fix starts no turn, and the item is
  // the only ask left. It closes when the conflict is gone.
  if (action === "fix") return args.events;
  if (action === "stop") {
    try {
      await addStoppedItem(args, history.fixes);
    } catch (error) {
      logFailOpenFailure(args.log, "GitHub merge conflict item failed", error, {
        number: args.ref.number,
        repository: args.ref.repositoryFullName,
      });
    }
  }
  return [];
}

/** Why a merge conflict item closes when GitHub reports no conflict. */
export const GITHUB_CONFLICT_GONE_REASON =
  "The pull request no longer has merge conflicts.";

/**
 * Close the stopped merge conflict item of one Junior pull request. Throws
 * when the review desk fails, so a caller with no later check can try again.
 */
export async function closeGitHubConflictItem(args: {
  db: GitHubDb;
  reason: string;
  ref: GitHubPullRequestRef;
  reviewItems: PluginConversationReviewItems;
  status: "done" | "dismissed";
}): Promise<void> {
  const { ref } = args;
  const opener = (
    await listGitHubPullRequestOpeners(args.db, {
      numbers: [ref.number],
      repositoryFullName: ref.repositoryFullName,
    })
  ).get(ref.number);
  if (!opener?.conversationId) return;
  await args.reviewItems.forConversation(opener.conversationId).close({
    dedupeKey: gitHubConflictItemKey(ref),
    reason: args.reason,
    status: args.status,
  });
}

/**
 * Close the stopped merge conflict items of some Junior pull requests, such
 * as ones that GitHub reports as mergeable. An item is optional, so a failed
 * close is logged, and the next check closes it again.
 */
export async function closeGitHubConflictItems(args: {
  db: GitHubDb;
  log?: Pick<PluginLogger, "error" | "warn">;
  numbers: number[];
  reason: string;
  repositoryFullName: string;
  reviewItems: PluginConversationReviewItems;
  status: "done" | "dismissed";
}): Promise<void> {
  if (args.numbers.length === 0) return;
  const { repositoryFullName } = args;
  const openers = await listGitHubPullRequestOpeners(args.db, {
    numbers: args.numbers,
    repositoryFullName,
  });
  const limit = pLimit(ITEM_CLOSE_CONCURRENCY);
  const close = async (number: number, conversationId: string) => {
    try {
      await args.reviewItems.forConversation(conversationId).close({
        dedupeKey: gitHubConflictItemKey({ number, repositoryFullName }),
        reason: args.reason,
        status: args.status,
      });
    } catch (error) {
      logFailOpenFailure(
        args.log,
        "GitHub merge conflict item close failed",
        error,
        { number, repository: repositoryFullName },
      );
    }
  };
  await Promise.all(
    [...openers].flatMap(([number, { conversationId }]) =>
      conversationId ? [limit(() => close(number, conversationId))] : [],
    ),
  );
}
