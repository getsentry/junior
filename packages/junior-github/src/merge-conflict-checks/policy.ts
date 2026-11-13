/**
 * When a merge conflict wakes Junior. A fix is a full agent turn, so only a
 * Junior pull request that people still work on gets one:
 *
 * - A draft gets nothing.
 * - In the first 2 days after the latest activity by a person, Junior fixes
 *   the conflict, at most once a day and 3 times in total.
 * - After that, or after the third fix, Junior adds a review desk notice to
 *   the Conversation that asked for the pull request.
 * - After 3 days without activity by a person, nothing.
 * - An approved pull request would be ready to merge but for the conflict,
 *   so it gets a fix after the 2 days too, and without the daily wait. The
 *   ready to merge notice needs a clean merge state, so it waits for the
 *   fix. The total limit still holds.
 *
 * Junior keeps no state for this. Each conflict reads the pull request's
 * history from GitHub. Opening the pull request counts as activity, because
 * a person asked for it. Merges and force pushes by a bot count as fixes.
 * The event key names the head commit, so a check of the same commit, or a
 * webhook and the heartbeat at once, publish one fix. A conflict on a pull
 * request that Junior did not open goes to its Watch as before, except for
 * a draft.
 */
import type {
  EventInput,
  PluginConversationReviewItems,
  PluginLogger,
} from "@sentry/junior-plugin-api";
import { and, eq } from "drizzle-orm";
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

const DAY_MS = 24 * 60 * 60_000;

/** Time after activity by a person in which Junior fixes conflicts. */
const ACTIVE_MS = 2 * DAY_MS;

/** Time after activity by a person after which conflicts do nothing. */
const IDLE_MS = 3 * DAY_MS;

/** Shortest time between two fixes of one pull request. */
const FIX_INTERVAL_MS = DAY_MS;

/** Fixes of one pull request before Junior only adds the notice. */
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
  let fixedAtMs: number | undefined;
  let fixes = 0;
  const record = (bot: boolean, fix: boolean, at: string | null) => {
    if (!at) return;
    const atMs = Date.parse(at);
    if (!bot) {
      activeAtMs = Math.max(activeAtMs, atMs);
    } else if (fix) {
      fixes += 1;
      fixedAtMs = Math.max(fixedAtMs ?? 0, atMs);
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
  return {
    activeAtMs,
    approved: pullRequest.reviewDecision === "APPROVED",
    fixes,
    ...(fixedAtMs === undefined ? undefined : { fixedAtMs }),
  };
}

type GitHubConflictAction = "fix" | "notice" | "skip";

/** Decide what a conflict on one open Junior pull request does. */
function gitHubConflictAction(
  history: GitHubConflictHistory,
  nowMs: number,
): GitHubConflictAction {
  const { approved, fixedAtMs } = history;
  const idleMs = nowMs - history.activeAtMs;
  if (idleMs > IDLE_MS && !approved) return "skip";
  if ((idleMs <= ACTIVE_MS || approved) && history.fixes < MAX_FIXES) {
    return !approved &&
      fixedAtMs !== undefined &&
      nowMs - fixedAtMs < FIX_INTERVAL_MS
      ? "skip"
      : "fix";
  }
  return "notice";
}

/** The dedupe key of the merge conflict notice of one pull request. */
export function gitHubConflictNoticeKey(ref: GitHubPullRequestRef): string {
  return `merge-conflict:${ref.repositoryFullName.toLowerCase()}#${ref.number}`;
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
  // An open notice with the key only gets new content, so a check of a
  // conflict that has a notice adds no second one.
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
 * optional, so a failure is logged, and the next check tries again.
 */
export async function applyGitHubConflictPolicy(args: {
  conflict: GitHubMergeConflict;
  db: GitHubDb;
  draft: boolean;
  events: EventInput[];
  /** Read the pull request's `PULL_REQUEST_CONFLICT_HISTORY` from GitHub. */
  loadHistory(ref: GitHubPullRequestRef): Promise<unknown>;
  log?: Pick<PluginLogger, "error" | "warn">;
  now: Date;
  ref: GitHubPullRequestRef;
  reviewItems: PluginConversationReviewItems;
  title?: string;
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
  const action = gitHubConflictAction(history, args.now.getTime());
  if (action === "fix") return args.events;
  if (action === "notice") {
    try {
      await addNotice(args, history.fixes);
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
  }
  return [];
}

/** Why a merge conflict notice closes when GitHub reports no conflict. */
export const GITHUB_CONFLICT_GONE_REASON =
  "The pull request no longer has merge conflicts.";

/**
 * Close the merge conflict notices of Junior pull requests that GitHub
 * reports as mergeable. A notice is optional, so a failed close is logged,
 * and the next check closes it again.
 */
export async function closeGitHubConflictNotices(args: {
  db: GitHubDb;
  log?: Pick<PluginLogger, "error" | "warn">;
  numbers: number[];
  repositoryFullName: string;
  reviewItems: PluginConversationReviewItems;
}): Promise<void> {
  if (args.numbers.length === 0) return;
  const { repositoryFullName } = args;
  const openers = await listGitHubPullRequestOpeners(args.db, {
    numbers: args.numbers,
    repositoryFullName,
  });
  for (const [number, opener] of openers) {
    if (!opener.conversationId) continue;
    try {
      await args.reviewItems.forConversation(opener.conversationId).close({
        dedupeKey: gitHubConflictNoticeKey({ number, repositoryFullName }),
        reason: GITHUB_CONFLICT_GONE_REASON,
        status: "done",
      });
    } catch (error) {
      logFailOpenFailure(
        args.log,
        "GitHub merge conflict notice close failed",
        error,
        { number, repository: repositoryFullName },
      );
    }
  }
}
