/**
 * When a merge conflict wakes Junior. A fix is a full agent turn, so only a
 * Junior pull request that people still work on gets one:
 *
 * - A draft gets nothing.
 * - In the first 2 days after the latest activity by a person, Junior fixes
 *   the conflict, at most once a day and 3 times in total.
 * - After that, or after the third fix, Junior adds one review desk notice
 *   to the Conversation that asked for the pull request. New activity by a
 *   person allows one more notice.
 * - After 3 days without activity by a person, nothing.
 * - An approved pull request would be ready to merge but for the conflict,
 *   so it gets a fix after the 2 days too, and without the daily wait. The
 *   ready to merge notice needs a clean merge state, so it waits for the
 *   fix. The total limit still holds.
 *
 * Opening the pull request counts as activity, because a person asked for
 * it. A conflict on a pull request that Junior did not open goes to its
 * Watch as before, except for a draft.
 */
import type {
  EventInput,
  PluginConversationReviewItems,
  PluginLogger,
} from "@sentry/junior-plugin-api";
import { and, eq, sql } from "drizzle-orm";
import type { GitHubDb } from "../db/database.js";
import { juniorGitHubPullRequests } from "../db/schema.js";
import { pullRequestRow } from "../pull-request-outcomes/store.js";
import { listGitHubPullRequestOpeners } from "../pull-request-requesters/store.js";
import { logFailOpenFailure } from "../webhooks/fail-open-log.js";
import type {
  GitHubMergeConflict,
  GitHubPullRequestRef,
} from "../webhooks/merge-conflict.js";

const DAY_MS = 24 * 60 * 60_000;

/** Time after activity by a person in which Junior fixes conflicts. */
const ACTIVE_MS = 2 * DAY_MS;

/** Time after activity by a person after which conflicts do nothing. */
const IDLE_MS = 3 * DAY_MS;

/** Shortest time between two fixes of one pull request. */
const FIX_INTERVAL_MS = DAY_MS;

/** Fixes of one pull request before Junior only adds the notice. */
const MAX_FIXES = 3;

/** The stored history that decides what a conflict does. */
interface GitHubConflictHistory {
  conflictFixedAt: Date | null;
  conflictFixes: number;
  conflictNoticedAt: Date | null;
  lastActivityAt: Date | null;
  openedAt: Date;
}

type GitHubConflictAction = "fix" | "notice" | "skip";

/** Decide what a conflict on one open Junior pull request does. */
function gitHubConflictAction(
  history: GitHubConflictHistory,
  nowMs: number,
  approved: boolean,
): GitHubConflictAction {
  const activeAtMs = Math.max(
    history.openedAt.getTime(),
    history.lastActivityAt?.getTime() ?? 0,
  );
  const idleMs = nowMs - activeAtMs;
  if (idleMs > IDLE_MS && !approved) return "skip";
  if ((idleMs <= ACTIVE_MS || approved) && history.conflictFixes < MAX_FIXES) {
    const fixedAtMs = history.conflictFixedAt?.getTime();
    return !approved &&
      fixedAtMs !== undefined &&
      nowMs - fixedAtMs < FIX_INTERVAL_MS
      ? "skip"
      : "fix";
  }
  return history.conflictNoticedAt &&
    history.conflictNoticedAt.getTime() >= activeAtMs
    ? "skip"
    : "notice";
}

/** The dedupe key of the merge conflict notice of one pull request. */
export function gitHubConflictNoticeKey(ref: GitHubPullRequestRef): string {
  return `merge-conflict:${ref.repositoryFullName.toLowerCase()}#${ref.number}`;
}

/**
 * Record a push, review, or comment by a person on a Junior pull request.
 * A late webhook does not move the time back.
 */
export async function recordGitHubPullRequestActivity(
  db: GitHubDb,
  activity: { at: Date; number: number; repositoryProviderId: string },
): Promise<void> {
  const t = juniorGitHubPullRequests;
  await db
    .update(t)
    .set({ lastActivityAt: sql`greatest(${t.lastActivityAt}, ${activity.at})` })
    .where(
      and(
        eq(t.repositoryId, activity.repositoryProviderId),
        eq(t.number, activity.number),
      ),
    );
}

async function addNotice(
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
  const name = title ? `**${title}**` : "This pull request";
  const reason =
    fixes >= MAX_FIXES
      ? `Junior already fixed conflicts ${fixes} times`
      : "nobody worked on it in the last 2 days";
  await args.reviewItems.forConversation(opener.conversationId).upsert({
    assigneeIdentityIds: [opener.identityId],
    body: `${name} has merge conflicts with \`${conflict.baseBranch}\`. Junior does not fix them on its own, because ${reason}. Ask Junior in this thread to fix them: ${url}`,
    dedupeKey: gitHubConflictNoticeKey(ref),
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
 * A notice goes to the review desk and returns no events. The notice is
 * optional, so a failure is logged, and the next idle stretch tries again.
 */
export async function applyGitHubConflictPolicy(args: {
  /** GitHub's review decision is `APPROVED`. */
  approved: boolean;
  conflict: GitHubMergeConflict;
  db: GitHubDb;
  draft: boolean;
  events: EventInput[];
  log?: Pick<PluginLogger, "error" | "warn">;
  now: Date;
  ref: GitHubPullRequestRef;
  reviewItems: PluginConversationReviewItems;
  title?: string;
}): Promise<EventInput[]> {
  if (args.draft) return [];
  const t = juniorGitHubPullRequests;
  const [row] = await args.db
    .select()
    .from(t)
    .where(and(pullRequestRow(args.ref), eq(t.state, "open")))
    .limit(1);
  if (!row) return args.events;
  const action = gitHubConflictAction(row, args.now.getTime(), args.approved);
  if (action === "fix") {
    await args.db
      .update(t)
      .set({
        conflictFixedAt: args.now,
        conflictFixes: sql`${t.conflictFixes} + 1`,
      })
      .where(eq(t.pullRequestId, row.pullRequestId));
    return args.events;
  }
  if (action === "notice") {
    try {
      await addNotice(args, row.conflictFixes);
    } catch (error) {
      logFailOpenFailure(
        args.log,
        "GitHub merge conflict notice failed",
        error,
        {
          number: args.ref.number,
          repository: args.ref.repositoryFullName,
        },
      );
    }
    await args.db
      .update(t)
      .set({ conflictNoticedAt: args.now })
      .where(eq(t.pullRequestId, row.pullRequestId));
  }
  return [];
}
