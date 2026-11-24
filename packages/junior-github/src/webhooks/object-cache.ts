import type { PluginCache, PluginState } from "@sentry/junior-plugin-api";
import * as z from "zod";
import {
  GITHUB_ISSUE_CACHE,
  GITHUB_PULL_REQUEST_CACHE,
  githubIssueFieldsSchema,
  githubObjectCacheKey,
  githubPullRequestFieldsSchema,
  type GitHubPullRequestFields,
  mergeGitHubObject,
  mergeGitHubPullRequest,
} from "../object-cache.js";
import { scheduleGitHubPullRequestPatch } from "../pull-request-patches.js";

const repositorySchema = z.object({ full_name: z.string().min(1) });
const issueEventSchema = z.object({
  action: z.string().optional(),
  issue: githubIssueFieldsSchema,
  repository: repositorySchema,
});
const pullRequestEventSchema = z.object({
  pull_request: githubPullRequestFieldsSchema,
  repository: repositorySchema,
});
const checkPullRequestsSchema = z.array(
  z.object({ number: z.number().int().positive() }),
);
const checkSuiteEventSchema = z.object({
  check_suite: z.object({
    head_sha: z.string().min(1),
    pull_requests: checkPullRequestsSchema,
  }),
  repository: repositorySchema,
});
const checkRunEventSchema = z.object({
  check_run: z.object({
    head_sha: z.string().min(1),
    pull_requests: checkPullRequestsSchema,
  }),
  repository: repositorySchema,
});

interface RefreshArgs {
  body: unknown;
  cache: PluginCache;
  nowMs: number;
  state: PluginState;
}

async function refreshPullRequest(
  args: RefreshArgs,
  event: z.output<typeof pullRequestEventSchema>,
): Promise<void> {
  const { pull_request: payload, repository } = event;
  const key = githubObjectCacheKey(
    "pulls",
    repository.full_name,
    payload.number,
  );
  let patch: GitHubPullRequestFields | undefined;
  await args.cache.update<GitHubPullRequestFields | null>(key, (current) => {
    const merged = mergeGitHubPullRequest(current, payload);
    if (merged?.patch) patch = merged.fields;
    return merged && { ...GITHUB_PULL_REQUEST_CACHE, value: merged.fields };
  });
  if (patch?.node_id) {
    await scheduleGitHubPullRequestPatch({
      key,
      nodeId: patch.node_id,
      nowMs: args.nowMs,
      state: args.state,
    });
  }
}

// A check event carries no counts, so the checks of that head commit turn
// pending until a patch counts them.
async function refreshChecks(
  args: RefreshArgs,
  keys: string[],
  sha: string,
): Promise<void> {
  for (const key of keys) {
    let nodeId: string | undefined;
    // oxlint-disable-next-line no-await-in-loop -- A check event names one or a few pull requests.
    await args.cache.update<GitHubPullRequestFields | null>(key, (current) => {
      if (current?.state !== "open" || current.head?.sha !== sha)
        return undefined;
      nodeId = current.node_id;
      return {
        ...GITHUB_PULL_REQUEST_CACHE,
        value: { ...current, checks: "pending" },
      };
    });
    if (nodeId) {
      // oxlint-disable-next-line no-await-in-loop -- A check event names one or a few pull requests.
      await scheduleGitHubPullRequestPatch({
        key,
        nodeId,
        nowMs: args.nowMs,
        state: args.state,
      });
    }
  }
}

function checkEventTarget(
  body: unknown,
  eventName: string,
): { keys: string[]; sha: string } | undefined {
  const event =
    eventName === "check_suite"
      ? checkSuiteEventSchema.safeParse(body)
      : eventName === "check_run"
        ? checkRunEventSchema.safeParse(body)
        : undefined;
  if (!event?.success) return undefined;
  const { repository } = event.data;
  const check =
    "check_suite" in event.data ? event.data.check_suite : event.data.check_run;
  return {
    keys: check.pull_requests.map((pull) =>
      githubObjectCacheKey("pulls", repository.full_name, pull.number),
    ),
    sha: check.head_sha,
  };
}

/**
 * Write the issue or pull request of an `issues` or `pull_request` webhook
 * into its cache entry, so the next card read shows it without a GitHub
 * call. A `check_suite` or `check_run` webhook marks the checks
 * of its pull requests pending. Merge state and checks that turn pending
 * get a patch (`pull-request-patches.ts`).
 */
export async function refreshGitHubObjectCache(
  args: RefreshArgs & { eventName: string },
): Promise<void> {
  if (args.eventName === "pull_request") {
    const event = pullRequestEventSchema.safeParse(args.body);
    if (event.success) await refreshPullRequest(args, event.data);
    return;
  }
  if (args.eventName === "issues") {
    const event = issueEventSchema.safeParse(args.body);
    if (!event.success) return;
    const { action, issue, repository } = event.data;
    const key = githubObjectCacheKey(
      "issues",
      repository.full_name,
      issue.number,
    );
    // A moved issue redirects to its new repository. The payload is about
    // the old one, so the next read follows the redirect again.
    if (action === "transferred") {
      await args.cache.delete(key);
      return;
    }
    await args.cache.update<typeof issue | null>(key, (current) => {
      // A deleted issue is gone, as a read would find.
      if (action === "deleted") return { ...GITHUB_ISSUE_CACHE, value: null };
      const value = mergeGitHubObject(current, issue);
      return value && { ...GITHUB_ISSUE_CACHE, value };
    });
    return;
  }
  const target = checkEventTarget(args.body, args.eventName);
  if (target) await refreshChecks(args, target.keys, target.sha);
}
