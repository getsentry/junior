/**
 * Merge conflict checks on pull request webhook events.
 *
 * GitHub sends no webhook when a pull request gets a conflict, and a
 * conflicted pull request gets no new checks. So when a webhook delivers
 * another event for a watched pull request, such as a comment, a review, or a
 * check result, the webhook also reads its mergeability and publishes
 * `pull_request.merge_conflict`. A push to the default branch also starts a
 * check of the repository's open Junior pull requests. See
 * `merge-conflict-checks/`.
 */
import type {
  EventInput,
  EventPublisher,
  PluginConversationReviewItems,
  PluginLogger,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import type { GitHubDb } from "../db/database.js";
import { gitHubPullRequestResource } from "../events/pull-request.js";
import { gitHubRepoDataSchema } from "../events/scope.js";
import { applyGitHubConflictPolicy } from "../merge-conflict-checks/policy.js";
import { pullRequestTargets } from "./event-targets.js";
import { logFailOpenFailure } from "./fail-open-log.js";

const EVENT_TYPE = "pull_request.merge_conflict";

/** Events after which the pull request cannot get a conflict. */
const CLOSED_EVENT_TYPES = new Set([
  "pull_request.closed_unmerged",
  "pull_request.merged",
]);

/** The pull request fields that tell if it has a conflict. */
const pullRequestSchema = z.object({
  base: z.object({ ref: z.string().min(1) }),
  draft: z.boolean().optional(),
  number: z.number().int().positive().optional(),
  head: z.object({ sha: z.string().min(1) }),
  html_url: z.string().min(1).optional(),
  mergeable: z.boolean().nullable().optional(),
  mergeable_state: z.string().optional(),
  state: z.string(),
  title: z.string().optional(),
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

/**
 * Return the pull request from a `pull_request` webhook payload when it is
 * `ref` and GitHub already knows its mergeability. Other webhooks, such as
 * reviews, comments, and check results, do not send mergeability.
 */
function deliveredPullRequest(
  payload: unknown,
  ref: GitHubPullRequestRef,
): z.infer<typeof pullRequestSchema> | undefined {
  const parsed = z
    .object({ pull_request: pullRequestSchema })
    .safeParse(payload);
  const pullRequest = parsed.success ? parsed.data.pull_request : undefined;
  return pullRequest?.number === ref.number &&
    typeof pullRequest.mergeable === "boolean"
    ? pullRequest
    : undefined;
}

/**
 * Return `pull_request.merge_conflict` events for the open pull requests that
 * these events are about, when a Watch or event automation wants them and
 * GitHub reports a conflict. A `pull_request` webhook payload gives the
 * mergeability when GitHub knows it. Otherwise the check reads the pull
 * request, which also makes GitHub calculate its mergeability. When GitHub
 * does not know it yet, a later event reads it again. The policy in
 * `merge-conflict-checks/policy.ts` decides if a conflict publishes.
 */
export async function loadGitHubMergeConflictEvents(args: {
  db: GitHubDb;
  deliveryId: string;
  events: EventInput[];
  hasMatch: EventPublisher["hasMatch"];
  loadPullRequest?(ref: GitHubPullRequestRef): Promise<unknown>;
  loadConflictHistory?(ref: GitHubPullRequestRef): Promise<unknown>;
  log?: Pick<PluginLogger, "error" | "warn">;
  /** The body of a `pull_request` webhook. */
  pullRequestPayload?: unknown;
  reviewItems: PluginConversationReviewItems;
}): Promise<EventInput[]> {
  const { hasMatch, loadConflictHistory, loadPullRequest } = args;
  if (!hasMatch || !loadPullRequest || !loadConflictHistory) return [];
  const conflicts: EventInput[] = [];
  for (const ref of pullRequestRefs(args.events)) {
    // Merge conflict events match only `repo` and `pullRequest`, so this
    // answer is the same as for the full events.
    if (!(await hasMatch(gitHubMergeConflictEvents(ref)))) continue;
    try {
      const loaded =
        deliveredPullRequest(args.pullRequestPayload, ref) ??
        pullRequestSchema.parse(await loadPullRequest(ref));
      if (
        loaded.state !== "open" ||
        loaded.mergeable !== false ||
        loaded.mergeable_state !== "dirty"
      ) {
        continue;
      }
      const conflict: GitHubMergeConflict = {
        baseBranch: loaded.base.ref,
        headSha: loaded.head.sha,
        ...(loaded.html_url ? { url: loaded.html_url } : undefined),
      };
      conflicts.push(
        ...(await applyGitHubConflictPolicy({
          conflict,
          db: args.db,
          draft: loaded.draft === true,
          events: gitHubMergeConflictEvents({ ...ref, conflict }),
          loadHistory: loadConflictHistory,
          log: args.log,
          now: new Date(),
          ref,
          reviewItems: args.reviewItems,
          ...(loaded.title ? { title: loaded.title } : undefined),
        })),
      );
    } catch (error) {
      // The delivered events still publish without the conflict check.
      logFailOpenFailure(
        args.log,
        "GitHub pull request merge conflict check failed",
        error,
        {
          deliveryId: args.deliveryId,
          pullRequest: ref.number,
          repository: ref.repositoryFullName,
        },
      );
    }
  }
  return conflicts;
}
