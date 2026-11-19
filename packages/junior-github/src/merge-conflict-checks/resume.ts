/**
 * Resume on the stopped merge conflict item (`policy.ts`). It counts as
 * activity by a person, so the fix count starts again, and it starts a fix
 * at once, through the same `pull_request.merge_conflict` event as a fix
 * that the policy allows.
 */
import type { EventPublisher } from "@sentry/junior-plugin-api";
import { and, eq } from "drizzle-orm";
import type { GitHubDb } from "../db/database.js";
import { juniorGitHubPullRequests } from "../db/schema.js";
import { pullRequestRow } from "../pull-request-outcomes/store.js";
import {
  gitHubMergeConflictEvents,
  gitHubPullRequestMergeSchema,
  type GitHubPullRequestRef,
} from "../webhooks/merge-conflict.js";

/**
 * Resume merge conflict fixes of one open Junior pull request, and start a
 * fix when GitHub does not say that it can merge. Safe to repeat for one
 * item: the event key names the item, so a retry publishes no second fix.
 */
export async function resumeGitHubConflictFixes(args: {
  db: GitHubDb;
  events: EventPublisher;
  /** The answered item. */
  itemId: string;
  loadPullRequest(ref: GitHubPullRequestRef): Promise<unknown>;
  nowMs: number;
  ref: GitHubPullRequestRef;
}): Promise<void> {
  const t = juniorGitHubPullRequests;
  const resumed = await args.db
    .update(t)
    .set({ conflictFixesResumedAt: new Date(args.nowMs) })
    .where(and(pullRequestRow(args.ref), eq(t.state, "open")))
    .returning({ pullRequestId: t.pullRequestId });
  if (resumed.length === 0) return;
  const loaded = gitHubPullRequestMergeSchema.parse(
    await args.loadPullRequest(args.ref),
  );
  if (loaded.state !== "open" || loaded.mergeable === true) return;
  const events = gitHubMergeConflictEvents({
    ...args.ref,
    conflict: {
      baseBranch: loaded.base.ref,
      headSha: loaded.head.sha,
      ...(loaded.html_url ? { url: loaded.html_url } : undefined),
    },
  });
  for (const event of events) {
    // A fix of the same head commit may have run already, so the key names
    // the Resume too.
    // oxlint-disable-next-line no-await-in-loop -- Publish in order, so watchers see events in the order they happened.
    await args.events.publish({
      ...event,
      eventKey: `${event.eventKey}:resume:${args.itemId}`,
    });
  }
}
