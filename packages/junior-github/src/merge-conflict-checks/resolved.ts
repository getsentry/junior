/**
 * `pull_request.merge_conflict.resolved`: a pull request that had a merge
 * conflict can merge cleanly again.
 *
 * GitHub sends no webhook when a pull request gets a conflict or loses it,
 * and it keeps no history of the merge state. So each read that finds a
 * conflict marks the pull request in plugin state. A later read that finds
 * no conflict publishes the event once and drops the mark. Without a mark,
 * a clean read publishes nothing, so a pull request that never had a
 * conflict sends no event on each push.
 *
 * The reads that mark are the webhook merge conflict check, the heartbeat
 * conflict check, a `pull_request` webhook, and the merge state patch after
 * a push. A card read cannot write plugin state, so a conflict that only a
 * card read found reaches the mark through the cache entry, at the next
 * push. The reads that publish are the patch, the heartbeat conflict check,
 * and the webhook merge conflict check, which reads when a waiter wants this
 * event. So a push that fixes the conflict publishes within minutes, and a
 * conflict that a change on the base branch fixes publishes at the next
 * read: the next comment, review, check result, or push.
 */
import type {
  EventInput,
  EventPublisher,
  PluginState,
} from "@sentry/junior-plugin-api";
import { gitHubPullRequestResource } from "../events/pull-request.js";
import { gitHubRepoDataSchema } from "../events/scope.js";
import { pullRequestTargets } from "../webhooks/event-targets.js";
import type { GitHubPullRequestRef } from "../webhooks/merge-conflict.js";

const EVENT_TYPE = "pull_request.merge_conflict.resolved";

// A conflict can wait for a fix this long. Each read that finds it again
// starts the time again.
const MARK_TTL_MS = 30 * 24 * 60 * 60_000;

function markKey(ref: GitHubPullRequestRef): string {
  return `merge-conflict:seen:${ref.repositoryFullName.toLowerCase()}#${ref.number}`;
}

/** Mark a pull request that GitHub reports as conflicted. */
export async function markGitHubConflict(
  state: PluginState,
  ref: GitHubPullRequestRef,
): Promise<void> {
  await state.set(markKey(ref), true, MARK_TTL_MS);
}

/**
 * Build the `pull_request.merge_conflict.resolved` copies for one pull
 * request that can merge at `headSha`. The event key names the head
 * commit, so each fix publishes once.
 */
export function gitHubConflictResolvedEvents(
  ref: GitHubPullRequestRef,
  headSha: string,
): EventInput[] {
  const repo = gitHubRepoDataSchema.parse(ref.repositoryFullName);
  const resource = gitHubPullRequestResource({ number: ref.number, repo });
  return pullRequestTargets(
    {
      eventKey: `github:merge-conflict-resolved:${resource.identifier}:${headSha}`,
      eventType: EVENT_TYPE,
      identifier: resource.identifier,
      objectType: "code_change",
      occurredAtMs: Date.now(),
      trustedSummary: `${resource.label} no longer has merge conflicts.`,
      data: { repo, pullRequest: ref.number, headSha },
    },
    repo,
  );
}

/**
 * Publish `pull_request.merge_conflict.resolved` for a marked pull request
 * that GitHub reports as mergeable at `headSha`, then drop its mark. A
 * failed publish keeps the mark, so the next clean read publishes again.
 */
export async function publishGitHubConflictResolved(args: {
  events: Pick<EventPublisher, "publish">;
  headSha: string;
  ref: GitHubPullRequestRef;
  state: PluginState;
}): Promise<void> {
  const key = markKey(args.ref);
  if (!(await args.state.get(key))) return;
  for (const event of gitHubConflictResolvedEvents(args.ref, args.headSha)) {
    // oxlint-disable-next-line no-await-in-loop -- Publish in order, as webhooks do.
    await args.events.publish(event);
  }
  await args.state.delete(key);
}
