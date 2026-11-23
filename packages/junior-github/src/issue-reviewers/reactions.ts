/**
 * The heartbeat part of issue review items. GitHub sends no webhook for a
 * reaction, so each heartbeat reads the reactions of a few issues that wait
 * on a review, and closes the item of each reviewer who reacted. Each read
 * after the first is conditional, so an unchanged issue costs no rate limit.
 */
import type {
  PluginConversationInboxItems,
  PluginLogger,
} from "@sentry/junior-plugin-api";
import pLimit from "p-limit";
import * as z from "zod";
import { GitHubRequestError } from "../credential-support.js";
import type { GitHubDb } from "../db/database.js";
import { logFailOpenFailure } from "../webhooks/fail-open-log.js";
import { closeGitHubIssueReviews } from "./items.js";
import {
  claimGitHubIssueReviewersForReactions,
  type GitHubIssueRef,
} from "./store.js";

/** Reviewers whose reactions one heartbeat reads. */
const CHECK_LIMIT = 20;

/** Issues whose reactions one heartbeat reads at once, under GitHub rate limits. */
const READ_CONCURRENCY = 4;

/** Time between two reads for one reviewer. */
const RECHECK_MS = 5 * 60_000;

/**
 * After this time, only a comment or the close ends an item, so a dismissed
 * item on an issue that stays open is not read forever.
 */
const CHECK_WINDOW_MS = 30 * 24 * 60 * 60_000;

// A deleted account's reaction has a null `user`.
const reactionsSchema = z.array(
  z.object({ user: z.object({ login: z.string().min(1) }).nullable() }),
);

/** Close the review items of reviewers who reacted to their issue. */
export async function checkGitHubIssueReviewReactions(args: {
  db: GitHubDb;
  inboxItems: PluginConversationInboxItems;
  loadReactions(issue: GitHubIssueRef): Promise<unknown>;
  log?: Pick<PluginLogger, "error" | "warn"> | undefined;
  now: Date;
}): Promise<void> {
  const due = await claimGitHubIssueReviewersForReactions(args.db, {
    checkedBefore: new Date(args.now.getTime() - RECHECK_MS),
    limit: CHECK_LIMIT,
    now: args.now,
    since: new Date(args.now.getTime() - CHECK_WINDOW_MS),
  });
  const issues = new Map<string, GitHubIssueRef & { logins: string[] }>();
  for (const reviewer of due) {
    const key = `${reviewer.repositoryFullName}#${reviewer.number}`;
    const issue = issues.get(key) ?? {
      logins: [],
      number: reviewer.number,
      repositoryFullName: reviewer.repositoryFullName,
    };
    issue.logins.push(reviewer.login);
    issues.set(key, issue);
  }
  await pLimit(READ_CONCURRENCY).map(
    [...issues.values()],
    async ({ logins, ...issue }) => {
      try {
        const reacted = new Set(
          reactionsSchema
            .parse(await args.loadReactions(issue))
            .flatMap((reaction) =>
              reaction.user ? [reaction.user.login.toLowerCase()] : [],
            ),
        );
        const closing = logins.filter((login) => reacted.has(login));
        if (closing.length === 0) return;
        await closeGitHubIssueReviews({
          db: args.db,
          inboxItems: args.inboxItems,
          issue,
          logins: closing,
          reason: "They reacted to the issue.",
        });
      } catch (error) {
        if (
          error instanceof GitHubRequestError &&
          (error.status === 404 || error.status === 410)
        ) {
          await closeGitHubIssueReviews({
            db: args.db,
            inboxItems: args.inboxItems,
            issue,
            reason: "The issue is gone.",
            status: "dismissed",
          });
          return;
        }
        logFailOpenFailure(
          args.log,
          "GitHub issue review reaction check failed",
          error,
          { number: issue.number, repository: issue.repositoryFullName },
        );
      }
    },
  );
}
