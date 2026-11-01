/**
 * Merge conflict checks for open pull requests that Junior owns.
 *
 * GitHub sends no webhook when a pull request gets a conflict, and a
 * conflicted pull request gets no new checks. When the base branch moves
 * while a pull request is idle, no other event shows the conflict. The plugin
 * heartbeat reads mergeability for watched pull requests and publishes
 * `pull_request.merge_conflict`.
 */
import type {
  EventInput,
  EventPublisher,
  PluginLogger,
  PluginState,
} from "@sentry/junior-plugin-api";
import { z } from "zod";
import type { GitHubDb } from "./db/database.js";
import { gitHubPullRequestResource } from "./events/pull-request.js";
import { gitHubRepoDataSchema } from "./events/scope.js";
import { listOpenGitHubPullRequests } from "./pull-request-outcomes/store.js";
import { pullRequestTargets } from "./webhooks/event-targets.js";

const EVENT_TYPE = "pull_request.merge_conflict";
/** One check at most in this time, because the heartbeat runs each minute. */
const CHECK_INTERVAL_MS = 5 * 60 * 1000;
/** Open pull requests to look at for a Watch or event automation. */
const OPEN_PULL_REQUEST_LIMIT = 200;
/** GitHub reads in one check, so the check stays in the heartbeat timeout. */
const READ_LIMIT = 20;
/** Keep the notified head longer than a Watch can be active. */
const NOTIFIED_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** The pull request fields that tell if it has a conflict. */
const pullRequestSchema = z.object({
  base: z.object({ ref: z.string().min(1) }),
  head: z.object({ sha: z.string().min(1) }),
  html_url: z.string().min(1).optional(),
  mergeable: z.boolean().nullable().optional(),
  mergeable_state: z.string().optional(),
  state: z.string(),
});

interface OpenPullRequest {
  number: number;
  pullRequestId: string;
  repositoryFullName: string;
}

/** Values that GitHub reports for a conflicted pull request. */
export interface GitHubMergeConflict {
  baseBranch: string;
  headSha: string;
  url?: string;
}

/**
 * Build the `pull_request.merge_conflict` copies for one pull request. With
 * no conflict, the copies have only the values that filters can match.
 */
export function gitHubMergeConflictEvents(input: {
  conflict?: GitHubMergeConflict;
  number: number;
  repositoryFullName: string;
}): EventInput[] {
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

async function hasMatch(
  events: EventPublisher,
  pullRequest: OpenPullRequest,
): Promise<boolean> {
  // Merge conflict events match only `repo` and `pullRequest`, so this
  // answer is the same as for the full event.
  for (const event of gitHubMergeConflictEvents(pullRequest)) {
    if (await events.hasMatch?.(event)) return true;
  }
  return false;
}

/**
 * Publish `pull_request.merge_conflict` for watched open pull requests that
 * GitHub reports as conflicted. Each head commit publishes once. GitHub can
 * report mergeability as unknown while it calculates it, and a later check
 * reads it again.
 */
export async function checkGitHubPullRequestMergeConflicts(args: {
  db: GitHubDb;
  events: EventPublisher;
  loadPullRequest(pullRequest: {
    number: number;
    repositoryFullName: string;
  }): Promise<unknown>;
  log: PluginLogger;
  state: PluginState;
}): Promise<void> {
  if (!args.events.hasMatch) return;
  if (
    !(await args.state.setIfNotExists(
      "merge-conflicts:check",
      true,
      CHECK_INTERVAL_MS,
    ))
  ) {
    return;
  }
  const watched: OpenPullRequest[] = [];
  for (const pullRequest of await listOpenGitHubPullRequests(
    args.db,
    OPEN_PULL_REQUEST_LIMIT,
  )) {
    if (watched.length >= READ_LIMIT) break;
    if (await hasMatch(args.events, pullRequest)) watched.push(pullRequest);
  }
  for (const pullRequest of watched) {
    try {
      const loaded = pullRequestSchema.parse(
        await args.loadPullRequest(pullRequest),
      );
      if (
        loaded.state !== "open" ||
        loaded.mergeable !== false ||
        loaded.mergeable_state !== "dirty"
      ) {
        continue;
      }
      const notifiedKey = `merge-conflicts:notified:${pullRequest.pullRequestId}`;
      if ((await args.state.get<string>(notifiedKey)) === loaded.head.sha) {
        continue;
      }
      const conflict: GitHubMergeConflict = {
        baseBranch: loaded.base.ref,
        headSha: loaded.head.sha,
        ...(loaded.html_url ? { url: loaded.html_url } : undefined),
      };
      for (const event of gitHubMergeConflictEvents({
        ...pullRequest,
        conflict,
      })) {
        await args.events.publish(event);
      }
      await args.state.set(notifiedKey, loaded.head.sha, NOTIFIED_TTL_MS);
    } catch (error) {
      args.log.error("GitHub pull request merge conflict check failed", {
        errorType: error instanceof Error ? error.name : "UnknownError",
        pullRequest: pullRequest.number,
        repository: pullRequest.repositoryFullName,
      });
    }
  }
}
