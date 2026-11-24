/**
 * The cached GitHub issues and pull requests that cards read. Each entry
 * keeps the REST fields of one object that a card shows. A webhook merges
 * its payload into the entry, so the next card read needs no GitHub call.
 */
import * as z from "zod";

// Webhooks refresh a changed issue, so the TTL bounds only a change that
// sends no webhook.
const ISSUE_CACHE_TTL_MS = 60_000;

/**
 * How long a pull request entry is fresh. Pull request and check webhooks
 * refresh it, so this bounds only a change that sends no webhook, such as
 * a new review request from a person who left the repository.
 */
const GITHUB_PULL_REQUEST_CACHE_TTL_MS = 60 * 60_000;

/**
 * How long an issue entry is fresh. When GitHub fails after the TTL, the
 * card keeps the last object read. The repository access check still
 * expires, so access is never extended.
 */
export const GITHUB_ISSUE_CACHE = {
  staleIfError: true,
  ttlMs: ISSUE_CACHE_TTL_MS,
} as const;

/** How long a pull request entry is fresh, as for issues. */
export const GITHUB_PULL_REQUEST_CACHE = {
  staleIfError: true,
  ttlMs: GITHUB_PULL_REQUEST_CACHE_TTL_MS,
} as const;

/** The cache entry options of one collection. */
export function githubObjectCacheOptions(collection: "issues" | "pulls") {
  return collection === "pulls"
    ? GITHUB_PULL_REQUEST_CACHE
    : GITHUB_ISSUE_CACHE;
}

const person = z.object({ login: z.string() });
const label = z.union([z.string(), z.object({ name: z.string() })]);
// GitHub sends the whole object in each webhook, so these fields are
// always there.
const objectFields = {
  body: z.string().nullable().optional(),
  html_url: z.string(),
  number: z.number().int().positive(),
  state: z.string(),
  title: z.string(),
  updated_at: z.string().optional(),
  user: person.nullable().optional(),
};

/** The fields of an issue that its card reads. Unknown fields are dropped. */
export const githubIssueFieldsSchema = z.object({
  ...objectFields,
  assignees: z.array(person).optional(),
  labels: z.array(label).optional(),
  // The issues API also returns pull requests, with this field set.
  pull_request: z.object({}).optional(),
});

const count = z.number().int().nonnegative();

/** Check counts of a head commit, as a card shows them. */
const githubCheckCountsSchema = z.object({
  failed: count,
  passed: count,
  pending: count,
});

/**
 * The fields of a pull request that its card reads. `pending` marks merge
 * state and checks that a patch reads soon (`pull-request-patches.ts`).
 */
export const githubPullRequestFieldsSchema = z.object({
  ...objectFields,
  additions: count.optional(),
  base: z.object({ ref: z.string() }).optional(),
  changed_files: count.optional(),
  checks: z.union([githubCheckCountsSchema, z.literal("pending")]).optional(),
  deletions: count.optional(),
  draft: z.boolean().optional(),
  head: z.object({ ref: z.string(), sha: z.string().optional() }).optional(),
  mergeable: z
    .union([z.boolean(), z.literal("pending")])
    .nullable()
    .optional(),
  merged: z.boolean().optional(),
  // The GraphQL id, so one query can read many pull requests.
  node_id: z.string().optional(),
  requested_reviewers: z.array(person).optional(),
});

export type GitHubIssueFields = z.infer<typeof githubIssueFieldsSchema>;
export type GitHubPullRequestFields = z.infer<
  typeof githubPullRequestFieldsSchema
>;

/**
 * The cache key of one issue or pull request, such as
 * `pulls:getsentry/junior#12`.
 */
export function githubObjectCacheKey(
  collection: "issues" | "pulls",
  repo: string,
  number: number | string,
): string {
  return `${collection}:${repo}#${number}`.toLowerCase();
}

/** Whether `next` is older than `current`, so it must not replace it. */
export function isOlderGitHubObject(
  current: { updated_at?: string | undefined } | null | undefined,
  next: { updated_at?: string | undefined },
): boolean {
  return Boolean(
    current?.updated_at &&
    next.updated_at &&
    Date.parse(next.updated_at) < Date.parse(current.updated_at),
  );
}

/**
 * Merge webhook fields into a cached object. A field in the payload
 * replaces the cached one, and a missing field stays. Returns nothing when
 * the payload is older than the cached object.
 */
export function mergeGitHubObject<
  T extends GitHubIssueFields | GitHubPullRequestFields,
>(current: T | null | undefined, payload: T): T | undefined {
  if (isOlderGitHubObject(current, payload)) return undefined;
  return { ...current, ...payload };
}

/**
 * Merge a pull request webhook into its entry, and say whether its merge
 * state and checks need a patch. GitHub computes both for one head commit,
 * and sends `mergeable: null` while it computes. After a push, or with
 * `null`, the cached values are about an old commit, so they turn
 * `pending` until the patch reads them. Only an open pull request shows
 * them, so only an open one gets a patch. Keep this decision here, so a
 * later policy can change it in one place.
 */
export function mergeGitHubPullRequest(
  current: GitHubPullRequestFields | null | undefined,
  payload: GitHubPullRequestFields,
): { fields: GitHubPullRequestFields; patch: boolean } | undefined {
  const fields = mergeGitHubObject(current, payload);
  if (!fields) return undefined;
  const newHead =
    current?.head?.sha !== undefined &&
    payload.head?.sha !== undefined &&
    current.head.sha !== payload.head.sha;
  if (fields.state !== "open" || (payload.mergeable !== null && !newHead)) {
    return { fields, patch: false };
  }
  return {
    fields: { ...fields, checks: "pending", mergeable: "pending" },
    patch: true,
  };
}
