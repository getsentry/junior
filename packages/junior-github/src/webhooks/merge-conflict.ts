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
  PluginCodeChanges,
  PluginConversationInboxItems,
  PluginLogger,
  PluginState,
} from "@sentry/junior-plugin-api";
import pLimit from "p-limit";
import * as z from "zod";
import type { LoadGitHubTitleParts } from "./title-parts.js";
import type { GitHubDb } from "../db/database.js";
import { gitHubPullRequestResource } from "../events/pull-request.js";
import { gitHubRepoDataSchema } from "../events/scope.js";
import { applyGitHubConflictPolicy } from "../merge-conflict-checks/policy.js";
import {
  gitHubConflictResolvedEvents,
  markGitHubConflict,
  publishGitHubConflictResolved,
} from "../merge-conflict-checks/resolved.js";
import { pullRequestTargets } from "./event-targets.js";
import { logFailOpenFailure } from "./fail-open-log.js";

// Pull requests that one delivery checks at once, under GitHub rate limits.
const PULL_REQUEST_CHECK_CONCURRENCY = 5;

const EVENT_TYPE = "pull_request.merge_conflict";

/**
 * Events that start no check: after a close, the pull request cannot get a
 * conflict. After a push, GitHub has not calculated the merge state yet,
 * and the merge state patch reads it (`pull-request-patches.ts`).
 */
const UNCHECKED_EVENT_TYPES = new Set([
  "pull_request.closed_unmerged",
  "pull_request.merged",
  "pull_request.synchronized",
]);

/** The pull request fields that tell if it has a conflict. */
export const gitHubPullRequestMergeSchema = z.object({
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
      UNCHECKED_EVENT_TYPES.has(event.eventType) ||
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
): z.infer<typeof gitHubPullRequestMergeSchema> | undefined {
  const parsed = z
    .object({ pull_request: gitHubPullRequestMergeSchema })
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
 * `merge-conflict-checks/policy.ts` decides if a conflict publishes. When a
 * waiter wants `pull_request.merge_conflict.resolved`, the read also marks a
 * conflict, and a clean read publishes the fix of a marked one
 * (`merge-conflict-checks/resolved.ts`).
 */
export async function loadGitHubMergeConflictEvents(args: {
  codeChanges: Pick<PluginCodeChanges, "list">;
  db: GitHubDb;
  deliveryId: string;
  events: EventInput[];
  hasMatch: EventPublisher["hasMatch"];
  loadPullRequest?:
    | ((ref: GitHubPullRequestRef) => Promise<unknown>)
    | undefined;
  loadConflictHistory?:
    | ((ref: GitHubPullRequestRef) => Promise<unknown>)
    | undefined;
  loadTitleParts?: LoadGitHubTitleParts | undefined;
  log?: Pick<PluginLogger, "error" | "warn"> | undefined;
  /** The body of a `pull_request` webhook. */
  pullRequestPayload?: unknown;
  inboxItems: PluginConversationInboxItems;
  /** Publishes the fix of a marked conflict that a clean read finds. */
  publisher: Pick<EventPublisher, "publish">;
  state: PluginState;
}): Promise<EventInput[]> {
  const { hasMatch, loadConflictHistory, loadPullRequest } = args;
  if (!hasMatch || !loadPullRequest || !loadConflictHistory) return [];
  const check = async (ref: GitHubPullRequestRef): Promise<EventInput[]> => {
    // Merge conflict events match only `repo` and `pullRequest`, so these
    // answers are the same as for the full events. A waiter on the fix also
    // needs the read: it marks a conflict, and a clean read publishes the fix
    // of a marked one. The head commit names only the event key, so an empty
    // one gives the same answer.
    const [wantsConflict, wantsFix] = await Promise.all([
      hasMatch(gitHubMergeConflictEvents(ref)),
      hasMatch(gitHubConflictResolvedEvents(ref, "")),
    ]);
    if (!wantsConflict && !wantsFix) return [];
    try {
      const loaded =
        deliveredPullRequest(args.pullRequestPayload, ref) ??
        gitHubPullRequestMergeSchema.parse(await loadPullRequest(ref));
      if (loaded.state !== "open") return [];
      if (loaded.mergeable === true) {
        // Like the patch and the heartbeat, every clean read drops the mark,
        // so a later waiter does not wake on a fix that came before it.
        await publishGitHubConflictResolved({
          events: args.publisher,
          headSha: loaded.head.sha,
          ref,
          state: args.state,
        });
        return [];
      }
      if (loaded.mergeable !== false || loaded.mergeable_state !== "dirty") {
        return [];
      }
      await markGitHubConflict(args.state, ref);
      // The conflict policy and its Inbox items are for conflict waiters.
      if (!wantsConflict) return [];
      const conflict: GitHubMergeConflict = {
        baseBranch: loaded.base.ref,
        headSha: loaded.head.sha,
        ...(loaded.html_url ? { url: loaded.html_url } : undefined),
      };
      return await applyGitHubConflictPolicy({
        codeChanges: args.codeChanges,
        conflict,
        db: args.db,
        draft: loaded.draft === true,
        events: gitHubMergeConflictEvents({ ...ref, conflict }),
        loadHistory: loadConflictHistory,
        loadTitleParts: args.loadTitleParts,
        log: args.log,
        now: new Date(),
        ref,
        inboxItems: args.inboxItems,
        ...(loaded.title ? { title: loaded.title } : undefined),
      });
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
      return [];
    }
  };
  const conflicts = await pLimit(PULL_REQUEST_CHECK_CONCURRENCY).map(
    pullRequestRefs(args.events),
    (ref) => check(ref),
  );
  return conflicts.flat();
}
