/**
 * Resume on the merge conflict item of a fix that did not land
 * (`policy.ts`). It counts as activity by a person, so the fix count starts
 * again, and it starts a fix at once, through the same
 * `pull_request.merge_conflict` event as a fix that the policy allows. The
 * fix names the item, and the item history holds the Resume.
 */
import type {
  EventPublisher,
  PluginConversationWatches,
} from "@sentry/junior-plugin-api";
import { eq } from "drizzle-orm";
import type { GitHubDb } from "../db/database.js";
import { juniorGitHubPullRequests } from "../db/schema.js";
import {
  gitHubPullRequestCreateWatch,
  gitHubPullRequestSubscribable,
  type GitHubPullRequestSubscriptionConfig,
} from "../events/pull-request.js";
import { withGitHubConflictFix } from "./policy.js";
import {
  gitHubMergeConflictEvents,
  gitHubPullRequestMergeSchema,
  type GitHubPullRequestRef,
} from "../webhooks/merge-conflict.js";

/**
 * Resume merge conflict fixes of one open Junior pull request, and start a
 * fix when it is not a draft and GitHub does not say that it can merge.
 * Safe to repeat for one item: the event key names the item, so a retry publishes no second fix.
 */
export async function resumeGitHubConflictFixes(args: {
  db: GitHubDb;
  events: EventPublisher;
  /** The answered item. */
  itemId: string;
  loadPullRequest(ref: GitHubPullRequestRef): Promise<unknown>;
  nowMs: number;
  /** GitHub's id of the pull request. */
  pullRequestId: string;
  ref: GitHubPullRequestRef;
  /** The Watch that Junior makes for its pull requests, if the app has one. */
  subscription: GitHubPullRequestSubscriptionConfig | undefined;
  /** Watches of the item's Conversation. */
  watches: PluginConversationWatches;
}): Promise<void> {
  const t = juniorGitHubPullRequests;
  const pullRequest = eq(t.pullRequestId, args.pullRequestId);
  const [row] = await args.db
    .select({ fixes: t.conflictFixes })
    .from(t)
    .where(pullRequest);
  if (!row) return;
  const loaded = gitHubPullRequestMergeSchema.parse(
    await args.loadPullRequest(args.ref),
  );
  // A draft gets no fix, as in the policy. A Resume that starts no fix
  // saves nothing, so the next conflict asks again (`gitHubConflictAsks`).
  if (
    loaded.state !== "open" ||
    loaded.mergeable === true ||
    loaded.draft === true
  ) {
    return;
  }
  const events = gitHubMergeConflictEvents({
    ...args.ref,
    conflict: {
      baseBranch: loaded.base.ref,
      headSha: loaded.head.sha,
      ...(loaded.html_url ? { url: loaded.html_url } : undefined),
    },
  }).map((event) => ({
    ...event,
    // A fix of the same head commit may have run already, so the key names
    // the Resume too.
    eventKey: `${event.eventKey}:resume:${args.itemId}`,
  }));
  // The item's Conversation asked for the fix, and its Watch can expire
  // while fixes are stopped. Then add it again first, so the fix event
  // reaches that Conversation. A Watch that it still has stays as it is:
  // one with other events, such as the Watch of a draft, would get a
  // second Watch, and each would start a Turn.
  const resource = gitHubPullRequestSubscribable({
    canSubscribe: args.watches.canSubscribe,
    number: args.ref.number,
    repo: args.ref.repositoryFullName,
  });
  if (
    args.subscription &&
    resource &&
    !(await args.watches.watching({
      eventType: "pull_request.merge_conflict",
      identifier: resource.identifier,
    }))
  ) {
    await args.watches.subscribe({
      ...gitHubPullRequestCreateWatch(args.subscription, {
        draft: false,
      }),
      resource,
    });
  }
  // A failed publish saves no fix, so the next conflict check asks again
  // at once.
  for (const event of events) {
    // oxlint-disable-next-line no-await-in-loop -- Publish in order, so watchers see events in the order they happened.
    await args.events.publish(event);
  }
  // Save the fix after it publishes. The fix counts as the first in a row,
  // and the policy starts no second fix of this head commit.
  await args.db
    .update(t)
    .set({
      conflictFixes: withGitHubConflictFix(row.fixes, {
        atMs: args.nowMs,
        headSha: loaded.head.sha,
        itemId: args.itemId,
      }),
    })
    .where(pullRequest);
}
