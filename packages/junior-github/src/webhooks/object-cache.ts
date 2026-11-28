import type {
  ObjectSubject,
  PluginCache,
  PluginState,
  PluginTaskStarter,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import {
  GITHUB_ISSUE_CACHE,
  GITHUB_PULL_REQUEST_CACHE,
  githubIssueFieldsSchema,
  githubObjectCacheKey,
  githubPullRequestFieldsSchema,
  type GitHubPullRequestFields,
  mergeGitHubObject,
  markGitHubReviewCleared,
  mergeGitHubPullRequest,
  withoutGitHubReview,
} from "../object-cache.js";
import { GITHUB_INBOX_SUBJECTS } from "../inbox-subjects.js";
import { markGitHubConflict } from "../merge-conflict-checks/resolved.js";
import { startGitHubPullRequestPatch } from "../pull-request-patches.js";

const repositorySchema = z.object({ full_name: z.string().min(1) });
const issueEventSchema = z.object({
  action: z.string().optional(),
  issue: githubIssueFieldsSchema,
  repository: repositorySchema,
});
const pullRequestEventSchema = z.object({
  action: z.string().optional(),
  pull_request: githubPullRequestFieldsSchema,
  repository: repositorySchema,
});
const pullRequestReviewEventSchema = z.object({
  action: z.string().optional(),
  pull_request: z.object({
    head: z.object({ sha: z.string().min(1) }).optional(),
    number: z.number().int().positive(),
  }),
  repository: repositorySchema,
});

// Webhook actions that can change GitHub's review decision. They clear the
// cached decision, and a patch reads it again.
const REVIEW_ACTIONS = {
  pull_request: new Set(["review_requested", "review_request_removed"]),
  pull_request_review: new Set(["dismissed", "submitted"]),
};

const checkPullRequestsSchema = z.array(
  z.object({
    id: z.number().int().positive().optional(),
    number: z.number().int().positive(),
  }),
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

// GitHub can redeliver a webhook for 3 days, so a deleted issue stays gone
// that long.
const GONE_TTL_MS = 3 * 24 * 60 * 60_000;

// Marks a deleted issue in plugin state. Its write takes no lock, so it
// stays when the entry write cannot wait for a card read and drops the
// entry instead.
function goneKey(key: string): string {
  return `gone:${key}`;
}

const objectIdSchema = z.object({ id: z.number().int().positive() });

// The subject of the webhook's issue or pull request: GitHub's id, which
// names the object in Annotations. The cache entry does not keep it.
function webhookSubject(
  body: unknown,
  field: "issue" | "pull_request",
): ObjectSubject | undefined {
  const parsed = z.object({ [field]: objectIdSchema }).safeParse(body);
  if (!parsed.success) return undefined;
  return {
    id: String(parsed.data[field]!.id),
    kind:
      field === "issue"
        ? GITHUB_INBOX_SUBJECTS.issue
        : GITHUB_INBOX_SUBJECTS.pullRequest,
  };
}

// Whether a cache write changes what a card shows.
function sameValue(current: unknown, next: unknown): boolean {
  return JSON.stringify(current ?? null) === JSON.stringify(next ?? null);
}

interface RefreshArgs {
  body: unknown;
  cache: PluginCache;
  /** Marks the Conversations that annotate a changed object as changed. */
  objectChanged(subject: ObjectSubject): Promise<void>;
  nowMs: number;
  state: PluginState;
  tasks: PluginTaskStarter;
}

async function refreshPullRequest(
  args: RefreshArgs,
  event: z.output<typeof pullRequestEventSchema>,
): Promise<void> {
  const { action = "", pull_request: payload, repository } = event;
  const reviewChanged = REVIEW_ACTIONS.pull_request.has(action);
  const key = githubObjectCacheKey(
    "pulls",
    repository.full_name,
    payload.number,
  );
  let patch = false;
  let conflicted = false;
  let changed = false;
  if (reviewChanged) await markGitHubReviewCleared(args.cache, key);
  await args.cache.update<GitHubPullRequestFields | null>(key, (current) => {
    const merged = mergeGitHubPullRequest(current, payload);
    patch = merged?.patch ?? false;
    // A push or a new base hides the merge state of the old pair, so a
    // conflict that the entry knew, such as from a card read, is marked too.
    conflicted =
      merged?.fields.state === "open" &&
      (payload.mergeable === false || (patch && current?.mergeable === false));
    const value = merged
      ? {
          ...GITHUB_PULL_REQUEST_CACHE,
          value: reviewChanged
            ? withoutGitHubReview(merged.fields)
            : merged.fields,
        }
      : // An older payload changes no fields, but its review change still
        // makes the cached decision stale.
        reviewChanged && current?.review !== undefined
        ? { ...GITHUB_PULL_REQUEST_CACHE, value: withoutGitHubReview(current) }
        : undefined;
    changed = Boolean(value) && !sameValue(current, value?.value);
    return value;
  });
  const subject = webhookSubject(args.body, "pull_request");
  if (changed && subject) await args.objectChanged(subject);
  if (conflicted) {
    await markGitHubConflict(args.state, {
      number: payload.number,
      repositoryFullName: repository.full_name,
    });
  }
  // GitHub names the head commit in each pull request webhook.
  const sha = payload.head?.sha;
  if (sha && (patch || reviewChanged)) {
    await startGitHubPullRequestPatch({
      key,
      nowMs: args.nowMs,
      sha,
      tasks: args.tasks,
    });
  }
}

// A check event carries no counts, so the checks of that head commit turn
// pending until a patch counts them. A pull request with no entry gets a
// patch that stores its card.
async function refreshChecks(
  args: RefreshArgs,
  pulls: Array<{ key: string; subject?: ObjectSubject }>,
  sha: string,
): Promise<void> {
  for (const { key, subject } of pulls) {
    let patch = false;
    let changed = false;
    // oxlint-disable-next-line no-await-in-loop -- A check event names one or a few pull requests.
    await args.cache.update<GitHubPullRequestFields | null>(key, (current) => {
      // A patch stores the whole card of a pull request with no entry.
      if (current === undefined) {
        patch = true;
        return undefined;
      }
      if (current?.state !== "open" || current.head?.sha !== sha)
        return undefined;
      patch = true;
      changed = current.checks !== "pending";
      return {
        ...GITHUB_PULL_REQUEST_CACHE,
        value: { ...current, checks: "pending" },
      };
    });
    if (changed && subject) {
      // oxlint-disable-next-line no-await-in-loop -- A check event names one or a few pull requests.
      await args.objectChanged(subject);
    }
    if (patch) {
      // oxlint-disable-next-line no-await-in-loop -- A check event names one or a few pull requests.
      await startGitHubPullRequestPatch({
        key,
        nowMs: args.nowMs,
        sha,
        tasks: args.tasks,
      });
    }
  }
}

function checkEventTarget(
  body: unknown,
  eventName: string,
):
  | { pulls: Array<{ key: string; subject?: ObjectSubject }>; sha: string }
  | undefined {
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
    pulls: check.pull_requests.map((pull) => ({
      key: githubObjectCacheKey("pulls", repository.full_name, pull.number),
      ...(pull.id && {
        subject: {
          id: String(pull.id),
          kind: GITHUB_INBOX_SUBJECTS.pullRequest,
        },
      }),
    })),
    sha: check.head_sha,
  };
}

/**
 * Write the issue or pull request of an `issues` or `pull_request` webhook
 * into its cache entry, so the next card read needs no GitHub call. A
 * review webhook clears the review decision, and a check webhook marks the
 * checks pending. Both get a patch that reads them again, or stores a whole
 * card (`pull-request-patches.ts`). A write that changes an entry calls
 * `objectChanged`.
 */
export async function refreshGitHubObjectCache(
  args: RefreshArgs & { eventName: string },
): Promise<void> {
  if (args.eventName === "pull_request") {
    const event = pullRequestEventSchema.safeParse(args.body);
    if (event.success) await refreshPullRequest(args, event.data);
    return;
  }
  if (args.eventName === "pull_request_review") {
    const event = pullRequestReviewEventSchema.safeParse(args.body);
    if (!event.success) return;
    if (!REVIEW_ACTIONS.pull_request_review.has(event.data.action ?? "")) {
      return;
    }
    const key = githubObjectCacheKey(
      "pulls",
      event.data.repository.full_name,
      event.data.pull_request.number,
    );
    await markGitHubReviewCleared(args.cache, key);
    let changed = false;
    let sha = event.data.pull_request.head?.sha;
    await args.cache.update<GitHubPullRequestFields | null>(key, (current) => {
      sha ??= current?.head?.sha;
      if (current?.review === undefined) return undefined;
      changed = true;
      return {
        ...GITHUB_PULL_REQUEST_CACHE,
        value: withoutGitHubReview(current),
      };
    });
    const subject = webhookSubject(args.body, "pull_request");
    if (changed && subject) await args.objectChanged(subject);
    if (sha) {
      await startGitHubPullRequestPatch({
        key,
        nowMs: args.nowMs,
        sha,
        tasks: args.tasks,
      });
    }
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
    const subject = webhookSubject(args.body, "issue");
    if (action === "transferred") {
      await args.cache.delete(key);
      if (subject) await args.objectChanged(subject);
      return;
    }
    // A deleted issue is gone, as a read would find. A late delivery from
    // before the delete must not bring it back.
    if (action === "deleted") {
      await args.state.set(goneKey(key), true, GONE_TTL_MS);
      await args.cache.update(key, () => ({ ttlMs: GONE_TTL_MS, value: null }));
      if (subject) await args.objectChanged(subject);
      return;
    }
    if (await args.state.get(goneKey(key))) return;
    let changed = false;
    await args.cache.update<typeof issue | null>(key, (current) => {
      const value = mergeGitHubObject(current, issue);
      changed = Boolean(value) && !sameValue(current, value);
      return value && { ...GITHUB_ISSUE_CACHE, value };
    });
    if (changed && subject) await args.objectChanged(subject);
    return;
  }
  const target = checkEventTarget(args.body, args.eventName);
  if (target) await refreshChecks(args, target.pulls, target.sha);
}
