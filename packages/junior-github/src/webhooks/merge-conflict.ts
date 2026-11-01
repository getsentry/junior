/**
 * Merge conflict checks on pull request webhook events.
 *
 * GitHub sends no webhook when a pull request gets a conflict, and a
 * conflicted pull request gets no new checks. So when a webhook delivers
 * another event for a watched pull request, such as a comment, a review, or a
 * check result, the webhook also reads its mergeability and publishes
 * `pull_request.merge_conflict`.
 */
import type {
  EventInput,
  EventPublisher,
  PluginLogger,
} from "@sentry/junior-plugin-api";
import { z } from "zod";
import { gitHubPullRequestResource } from "../events/pull-request.js";
import { gitHubRepoDataSchema } from "../events/scope.js";
import { pullRequestTargets } from "./event-targets.js";

const EVENT_TYPE = "pull_request.merge_conflict";

/** Events after which the pull request cannot get a conflict. */
const CLOSED_EVENT_TYPES = new Set([
  "pull_request.closed_unmerged",
  "pull_request.merged",
]);

/** The pull request fields that tell if it has a conflict. */
const pullRequestSchema = z.object({
  base: z.object({ ref: z.string().min(1) }),
  head: z.object({ sha: z.string().min(1) }),
  html_url: z.string().min(1).optional(),
  mergeable: z.boolean().nullable().optional(),
  mergeable_state: z.string().optional(),
  state: z.string(),
});

/** Values that GitHub reports for a conflicted pull request. */
export interface GitHubMergeConflict {
  baseBranch: string;
  headSha: string;
  url?: string;
}

/** One pull request in one repository. */
export interface GitHubPullRequestRef {
  number: number;
  repositoryFullName: string;
}

/**
 * Build the `pull_request.merge_conflict` copies for one pull request. With
 * no conflict, the copies have only the values that filters can match. The
 * event key names the head commit, so each head commit publishes once.
 */
export function gitHubMergeConflictEvents(
  input: GitHubPullRequestRef & { conflict?: GitHubMergeConflict },
): EventInput[] {
  const { conflict } = input;
  const repo = gitHubRepoDataSchema.parse(input.repositoryFullName);
  const resource = gitHubPullRequestResource({ number: input.number, repo });
  return pullRequestTargets(
    {
      eventKey: `github:merge-conflict:${resource.identifier}${conflict ? `:${conflict.headSha}` : ""}`,
      eventType: EVENT_TYPE,
      identifier: resource.identifier,
      objectType: "code_change",
      occurredAtMs: Date.now(),
      trustedSummary: `${resource.label} has merge conflicts${conflict ? ` with ${conflict.baseBranch}` : ""}.`,
      data: { repo, pullRequest: input.number, ...conflict },
    },
    repo,
  );
}

/** Open pull requests that the delivered events are about. */
function pullRequestRefs(events: EventInput[]): GitHubPullRequestRef[] {
  const refs = new Map<string, GitHubPullRequestRef>();
  for (const event of events) {
    const { pullRequest, repo } = event.data ?? {};
    if (
      !event.eventType.startsWith("pull_request.") ||
      CLOSED_EVENT_TYPES.has(event.eventType) ||
      typeof pullRequest !== "number" ||
      typeof repo !== "string"
    ) {
      continue;
    }
    refs.set(`${repo}#${pullRequest}`, {
      number: pullRequest,
      repositoryFullName: repo,
    });
  }
  return [...refs.values()];
}

async function hasMatch(
  hasMatchEvent: NonNullable<EventPublisher["hasMatch"]>,
  ref: GitHubPullRequestRef,
): Promise<boolean> {
  // Merge conflict events match only `repo` and `pullRequest`, so this
  // answer is the same as for the full event.
  for (const event of gitHubMergeConflictEvents(ref)) {
    if (await hasMatchEvent(event)) return true;
  }
  return false;
}

/**
 * Return `pull_request.merge_conflict` events for the open pull requests that
 * these events are about, when a Watch or event automation wants them and
 * GitHub reports a conflict. Reading a pull request makes GitHub calculate
 * its mergeability. When GitHub does not know it yet, a later event reads it
 * again.
 */
export async function loadGitHubMergeConflictEvents(args: {
  deliveryId: string;
  events: EventInput[];
  hasMatch: EventPublisher["hasMatch"];
  loadPullRequest?(ref: GitHubPullRequestRef): Promise<unknown>;
  log?: Pick<PluginLogger, "error">;
}): Promise<EventInput[]> {
  const { hasMatch: hasMatchEvent, loadPullRequest } = args;
  if (!hasMatchEvent || !loadPullRequest) return [];
  const conflicts: EventInput[] = [];
  for (const ref of pullRequestRefs(args.events)) {
    if (!(await hasMatch(hasMatchEvent, ref))) continue;
    try {
      const loaded = pullRequestSchema.parse(await loadPullRequest(ref));
      if (
        loaded.state !== "open" ||
        loaded.mergeable !== false ||
        loaded.mergeable_state !== "dirty"
      ) {
        continue;
      }
      conflicts.push(
        ...gitHubMergeConflictEvents({
          ...ref,
          conflict: {
            baseBranch: loaded.base.ref,
            headSha: loaded.head.sha,
            ...(loaded.html_url ? { url: loaded.html_url } : undefined),
          },
        }),
      );
    } catch (error) {
      // The delivered events still publish without the conflict check.
      args.log?.error("GitHub pull request merge conflict check failed", {
        deliveryId: args.deliveryId,
        errorType: error instanceof Error ? error.name : "UnknownError",
        pullRequest: ref.number,
        repository: ref.repositoryFullName,
      });
    }
  }
  return conflicts;
}
