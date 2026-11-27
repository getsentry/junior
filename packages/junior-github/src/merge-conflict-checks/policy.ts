/**
 * When a merge conflict wakes Junior. A fix is a full agent turn, so only a
 * non-draft Junior PR within `ACTIVE_MS` of activity by a person gets one;
 * past that, a conflict tells nobody. An approved PR skips that wait, since
 * ready to merge needs a clean merge. A fix that did not land in a day asks
 * to resume, once per Resume. One head commit publishes one fix.
 */
import type {
  EventInput,
  PluginCodeChanges,
  PluginConversationInboxItems,
  PluginInboxItemRecord,
  PluginLogger,
} from "@sentry/junior-plugin-api";
import { eq } from "drizzle-orm";
import pLimit from "p-limit";
import * as z from "zod";
import type { GitHubDb } from "../db/database.js";
import {
  type GitHubConflictFix,
  juniorGitHubPullRequests,
} from "../db/schema.js";
import { findGitHubPullRequest } from "../pull-request-outcomes/store.js";
import {
  findGitHubPullRequestConversation,
  type GitHubPullRequestOpener,
  listGitHubPullRequestOpeners,
  recordGitHubPullRequestOpenerId,
} from "../pull-request-requesters/store.js";
import {
  GITHUB_INBOX_SUBJECTS,
  pullRequestSubject,
} from "../inbox-subjects.js";
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

/** Shortest time between two fixes of one pull request. */
const FIX_INTERVAL_MS = DAY_MS;

/** Fixes in a row, with no activity by a person, before Junior waits. */
const MAX_FIXES = 3;

/** The choice of the merge conflict item that resumes the fixes. */
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
    __typename: z.enum([
      "AutomaticBaseChangeSucceededEvent",
      "BaseRefChangedEvent",
      "HeadRefForcePushedEvent",
    ]),
    actor: actorSchema,
    createdAt: z.string(),
  }),
]);

const historyResponseSchema = z.object({
  data: z.object({
    repository: z.object({
      pullRequest: z.object({
        baseChanges: z.object({
          nodes: z.array(timelineItemSchema.nullable()),
        }),
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
  /** The latest activity by a person, or the opening. */
  activeAtMs: number;
  approved: boolean;
}

/**
 * Read the history from GitHub's answer. A deleted account counts as a
 * person, and a bot's activity is not activity. The opening counts, since a
 * person asked for it. So does a person's base change, such as the merge of
 * the PR below in a stack: its conflicts come from that merge, not from a
 * loop of fixes.
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
    ...pullRequest.baseChanges.nodes,
  ]) {
    if (!item) continue;
    switch (item.__typename) {
      case "PullRequestCommit":
        record(
          item.commit.author?.user?.login?.endsWith("[bot]") === true,
          item.commit.committedDate,
        );
        break;
      case "AutomaticBaseChangeSucceededEvent":
      case "BaseRefChangedEvent":
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

/** What people did on the merge conflict items of one pull request. */
export interface GitHubConflictAsks {
  /**
   * The latest ask is open, or a person dismissed it. Junior asks once
   * after each Resume, so a Dismiss ends the asks.
   */
  holds: boolean;
  /** The latest Resume that started a fix: its item, and when it ran. */
  resume?: { atMs: number; itemId: string };
  /**
   * The latest item closed with a Resume that has saved no fix yet. Core
   * closes the item before the Resume reads the pull request.
   */
  resuming: boolean;
}

// Longer than a Resume takes: a GitHub read and a publish. After it, a
// Resume with no fix started none, so the next conflict asks again.
const RESUMING_MS = 5 * 60_000;

/**
 * Read the asks from the item history of one pull request, newest first.
 * A Resume counts only when it started a fix, so one that started none,
 * such as on a draft, lets the next conflict ask again.
 */
export function gitHubConflictAsks(
  items: PluginInboxItemRecord[],
  fixes: GitHubConflictFix[],
  nowMs: number,
): GitHubConflictAsks {
  const [latest] = items;
  const holds = latest?.status === "open" || latest?.status === "dismissed";
  const resuming =
    latest?.choice === GITHUB_CONFLICT_RESUME &&
    nowMs - (latest.closedAtMs ?? 0) < RESUMING_MS &&
    !fixes.some(({ itemId }) => itemId === latest.id);
  const fix = [...fixes].reverse().find(({ itemId }) => itemId);
  const resumed = items.some(
    (item) => item.id === fix?.itemId && item.choice === GITHUB_CONFLICT_RESUME,
  );
  // The fix starts when the Resume runs, also on a retry of the answer.
  return fix?.itemId && resumed
    ? { holds, resume: { atMs: fix.atMs, itemId: fix.itemId }, resuming }
    : { holds, resuming };
}

/**
 * `retry` publishes a fix that started already again. `ask` adds the Review
 * item for a fix that did not land.
 */
type GitHubConflictAction = "ask" | "fix" | "retry" | "skip";

/** Decide what a conflict on one open Junior pull request does. */
function gitHubConflictAction(input: {
  asks: GitHubConflictAsks;
  fixes: GitHubConflictFix[];
  headSha: string;
  history: GitHubConflictHistory;
  nowMs: number;
}): GitHubConflictAction {
  const { asks, fixes, nowMs } = input;
  const { approved } = input.history;
  const resumedAtMs = asks.resume?.atMs ?? 0;
  // A Resume counts as activity by a person.
  const activeAtMs = Math.max(input.history.activeAtMs, resumedAtMs);
  // Upkeep follows people: an idle pull request gets no fix and no ask.
  if (nowMs - activeAtMs > ACTIVE_MS && !approved) return "skip";
  const started = fixes.find(({ headSha }) => headSha === input.headSha);
  if (started) {
    // A fix changes the head commit. So with the same head a day later, the
    // fix did not land.
    if (nowMs - started.atMs >= FIX_INTERVAL_MS) {
      return asks.holds ? "skip" : "ask";
    }
    // The policy's event key names the head commit, and core delivers each
    // key once, so its event publishes again: a publish that failed gets
    // another try. A Resume saves its fix after the publish, and its event
    // has its own key.
    return started.itemId === undefined ? "retry" : "skip";
  }
  // The fix that Resume started counts as the first in a row. The next
  // activity by a person starts the count again.
  if (fixes.filter(({ atMs }) => atMs >= activeAtMs).length >= MAX_FIXES) {
    return "skip";
  }
  // Only a pull request that is not approved waits a day between fixes.
  const fixedAtMs = Math.max(resumedAtMs, ...fixes.map(({ atMs }) => atMs));
  return !approved && nowMs - fixedAtMs < FIX_INTERVAL_MS ? "skip" : "fix";
}

/** Ask the requester to resume a fix that did not land. */
async function addUnlandedItem(args: {
  conflict: GitHubMergeConflict;
  db: GitHubDb;
  opener: GitHubPullRequestOpener & { conversationId: string };
  /** GitHub's id of the pull request, the id of its item. */
  pullRequestId: string;
  ref: GitHubPullRequestRef;
  inboxItems: PluginConversationInboxItems;
}): Promise<void> {
  const { conflict, opener, ref } = args;
  if (!opener.pullRequestId) {
    await recordGitHubPullRequestOpenerId(args.db, {
      conversationId: opener.conversationId,
      number: ref.number,
      pullRequestId: args.pullRequestId,
      repositoryFullName: ref.repositoryFullName,
    });
  }
  await args.inboxItems.forConversation(opener.conversationId).upsert({
    // The policy asks once per Resume, so each upsert is a new ask.
    askedIdentityIds: [opener.identityId],
    assigneeIdentityIds: [opener.identityId],
    body: `#${ref.number} conflicts with \`${conflict.baseBranch}\`, and the last fix did not land. Resume tries again. Dismiss stops these asks for this pull request.`,
    choices: [{ label: GITHUB_CONFLICT_RESUME }],
    subject: pullRequestSubject(
      GITHUB_INBOX_SUBJECTS.mergeConflict,
      args.pullRequestId,
    ),
    title: `Merge conflict · #${ref.number}`,
  });
}

/**
 * Return the merge conflict events to publish for one conflicted pull
 * request that a Watch or event automation wants. A fix returns `events`.
 * An ask adds the Inbox item and returns no events. The item is optional,
 * so a failure is logged, and the next check tries again.
 */
export async function applyGitHubConflictPolicy(args: {
  codeChanges: Pick<PluginCodeChanges, "list">;
  conflict: GitHubMergeConflict;
  db: GitHubDb;
  draft: boolean;
  events: EventInput[];
  /** Read the pull request's `PULL_REQUEST_CONFLICT_HISTORY` from GitHub. */
  loadHistory(ref: GitHubPullRequestRef): Promise<unknown>;
  log?: Pick<PluginLogger, "error" | "warn"> | undefined;
  now: Date;
  ref: GitHubPullRequestRef;
  inboxItems: PluginConversationInboxItems;
}): Promise<EventInput[]> {
  if (args.draft) return [];
  const change = await findGitHubPullRequest(args.codeChanges, args.ref);
  if (change?.state !== "open") return args.events;
  const t = juniorGitHubPullRequests;
  const pullRequest = eq(t.pullRequestId, change.providerId);
  const [row] = await args.db
    .select({ fixes: t.conflictFixes })
    .from(t)
    .where(pullRequest)
    .limit(1);
  // A pull request that Junior did not open goes to its Watch as before.
  if (!row) return args.events;
  const opener = (
    await listGitHubPullRequestOpeners(args.db, {
      numbers: [args.ref.number],
      repositoryFullName: args.ref.repositoryFullName,
    })
  ).get(args.ref.number);
  // Only a pull request that a person asked for has a Conversation. The
  // opener's row keeps the name from when Junior opened it, so the id finds
  // the item history after a rename.
  const conversationId =
    opener?.conversationId ??
    (await findGitHubPullRequestConversation(args.db, change.providerId));
  const items = conversationId
    ? await args.inboxItems
        .forConversation(conversationId)
        .history(
          pullRequestSubject(
            GITHUB_INBOX_SUBJECTS.mergeConflict,
            change.providerId,
          ),
        )
    : [];
  const nowMs = args.now.getTime();
  const asks = gitHubConflictAsks(items, row.fixes, nowMs);
  if (asks.resuming) return [];
  const action = gitHubConflictAction({
    asks,
    fixes: row.fixes,
    headSha: args.conflict.headSha,
    history: parseGitHubConflictHistory(await args.loadHistory(args.ref)),
    nowMs,
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
      .where(pullRequest);
    return args.events;
  }
  // Ask only in the opener's Conversation, as found by name.
  if (!opener?.conversationId) return [];
  try {
    // The item is the ask, so a failed item is asked again.
    await addUnlandedItem({
      ...args,
      opener: { ...opener, conversationId: opener.conversationId },
      pullRequestId: change.providerId,
    });
  } catch (error) {
    logFailOpenFailure(args.log, "GitHub merge conflict item failed", error, {
      number: args.ref.number,
      repository: args.ref.repositoryFullName,
    });
  }
  return [];
}

/** Why a merge conflict item closes when GitHub reports no conflict. */
export const GITHUB_CONFLICT_GONE_REASON =
  "The pull request no longer has merge conflicts.";

/**
 * Close the merge conflict item of one Junior pull request. Throws
 * when the Inbox fails, so a caller with no later check can try again.
 */
export async function closeGitHubConflictItem(args: {
  db: GitHubDb;
  /** GitHub's id of the pull request, the id of its item. */
  pullRequestId: string;
  reason: string;
  ref: GitHubPullRequestRef;
  inboxItems: PluginConversationInboxItems;
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
  await args.inboxItems.forConversation(opener.conversationId).close({
    subject: pullRequestSubject(
      GITHUB_INBOX_SUBJECTS.mergeConflict,
      args.pullRequestId,
    ),
    reason: args.reason,
    status: args.status,
  });
}

/**
 * Close the merge conflict items of some Junior pull requests, such
 * as ones that GitHub reports as mergeable. An item is optional, so a failed
 * close is logged, and the next check closes it again. When an open item
 * closes, the ask was not dismissed, so a later fix that does not land asks
 * again.
 */
export async function closeGitHubConflictItems(args: {
  codeChanges: Pick<PluginCodeChanges, "list">;
  db: GitHubDb;
  log?: Pick<PluginLogger, "error" | "warn">;
  numbers: number[];
  reason: string;
  repositoryFullName: string;
  inboxItems: PluginConversationInboxItems;
  status: "done" | "dismissed";
}): Promise<void> {
  if (args.numbers.length === 0) return;
  const { numbers, repositoryFullName } = args;
  const [openers, changes] = await Promise.all([
    listGitHubPullRequestOpeners(args.db, { numbers, repositoryFullName }),
    args.codeChanges.list({
      repository: { name: repositoryFullName, numbers },
    }),
  ]);
  const pullRequestIds = new Map(
    changes.map((change) => [change.number, change.providerId]),
  );
  const limit = pLimit(ITEM_CLOSE_CONCURRENCY);
  const close = async (
    number: number,
    conversationId: string,
    pullRequestId: string,
  ) => {
    try {
      await args.inboxItems.forConversation(conversationId).close({
        subject: pullRequestSubject(
          GITHUB_INBOX_SUBJECTS.mergeConflict,
          pullRequestId,
        ),
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
    [...openers].flatMap(([number, { conversationId }]) => {
      const pullRequestId = pullRequestIds.get(number);
      return conversationId && pullRequestId
        ? [limit(() => close(number, conversationId, pullRequestId))]
        : [];
    }),
  );
}
