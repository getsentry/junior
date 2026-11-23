/**
 * The heartbeat part of issue review items. GitHub sends no webhook for a
 * reaction, so each heartbeat reads a few open issues that Junior opened,
 * and closes the item of each assignee who reacted. Each read after the
 * first is conditional, so an unchanged issue costs no rate limit.
 */
import type {
  PluginConversationInboxItems,
  PluginLogger,
  PluginState,
} from "@sentry/junior-plugin-api";
import pLimit from "p-limit";
import * as z from "zod";
import type { GitHubDb } from "../db/database.js";
import {
  listOpenGitHubIssues,
  type OpenGitHubIssue,
} from "../issue-outcomes/store.js";
import { logFailOpenFailure } from "../webhooks/fail-open-log.js";
import { closeGitHubIssueReviews, type GitHubIssueRef } from "./items.js";

/** Issues that one heartbeat reads. */
const ISSUE_LIMIT = 10;

/** Issues that one heartbeat reads at once, under GitHub rate limits. */
const READ_CONCURRENCY = 4;

/**
 * After this time, only a comment or the close ends an item, so an issue
 * that stays open is not read forever.
 */
const CHECK_WINDOW_MS = 30 * 24 * 60 * 60_000;

// One heartbeat reads at a time, so two cannot read the same issues.
const LOCK_KEY = "issue-review-reactions:lock";
const LOCK_TTL_MS = 5 * 60_000;

// The last issue that a heartbeat read. The next heartbeat starts after it.
const CURSOR_KEY = "issue-review-reactions:cursor";
const CURSOR_TTL_MS = CHECK_WINDOW_MS;

const cursorSchema = z.object({
  issueId: z.string().min(1),
  openedAtMs: z.number(),
});

const loginSchema = z.object({ login: z.string().min(1) });

const issueSchema = z.object({
  assignees: z.array(loginSchema).default([]),
  reactions: z.object({ total_count: z.number() }).optional(),
  state: z.string(),
});

// A deleted account's reaction has a null `user`.
const reactionsSchema = z.array(z.object({ user: loginSchema.nullable() }));

interface ReactionReaders {
  loadIssue(issue: GitHubIssueRef): Promise<unknown>;
  loadReactions(issue: GitHubIssueRef): Promise<unknown>;
}

/** The assignees of an open issue who reacted to it. */
async function assigneesWhoReacted(
  readers: ReactionReaders,
  issue: GitHubIssueRef,
): Promise<string[]> {
  const current = issueSchema.parse(await readers.loadIssue(issue));
  if (
    current.state !== "open" ||
    current.assignees.length === 0 ||
    !current.reactions?.total_count
  ) {
    return [];
  }
  const reacted = new Set(
    reactionsSchema
      .parse(await readers.loadReactions(issue))
      .flatMap((reaction) =>
        reaction.user ? [reaction.user.login.toLowerCase()] : [],
      ),
  );
  return current.assignees
    .map((assignee) => assignee.login)
    .filter((login) => reacted.has(login.toLowerCase()));
}

/** Read the next issues after the saved cursor, and move the cursor. */
async function nextIssues(
  db: GitHubDb,
  state: PluginState,
  now: Date,
): Promise<OpenGitHubIssue[]> {
  const cursor = cursorSchema.safeParse(await state.get(CURSOR_KEY));
  const issues = await listOpenGitHubIssues(db, {
    ...(cursor.success
      ? {
          after: {
            issueId: cursor.data.issueId,
            openedAt: new Date(cursor.data.openedAtMs),
          },
        }
      : undefined),
    limit: ISSUE_LIMIT,
    since: new Date(now.getTime() - CHECK_WINDOW_MS),
  });
  const last = issues.at(-1);
  // A short page is the end of the list, so the next heartbeat starts over.
  if (issues.length < ISSUE_LIMIT || !last) {
    await state.delete(CURSOR_KEY);
  } else {
    await state.set(
      CURSOR_KEY,
      { issueId: last.issueId, openedAtMs: last.openedAt.getTime() },
      CURSOR_TTL_MS,
    );
  }
  return issues;
}

/** Close the review items of assignees who reacted to their issue. */
export async function checkGitHubIssueReviewReactions(
  args: ReactionReaders & {
    db: GitHubDb;
    inboxItems: PluginConversationInboxItems;
    log?: Pick<PluginLogger, "error" | "warn"> | undefined;
    now: Date;
    state: PluginState;
  },
): Promise<void> {
  await args.state.withLock(LOCK_KEY, LOCK_TTL_MS, async () => {
    const issues = await nextIssues(args.db, args.state, args.now);
    await pLimit(READ_CONCURRENCY).map(issues, async (row) => {
      const issue = {
        number: row.number,
        repositoryFullName: row.repositoryFullName,
      };
      try {
        const logins = await assigneesWhoReacted(args, issue);
        if (logins.length === 0) return;
        await closeGitHubIssueReviews({
          conversationIds: row.conversationIds,
          inboxItems: args.inboxItems,
          issue,
          logins,
          reason: "They reacted to the issue.",
        });
      } catch (error) {
        logFailOpenFailure(
          args.log,
          "GitHub issue review reaction check failed",
          error,
          { number: issue.number, repository: issue.repositoryFullName },
        );
      }
    });
  });
}
