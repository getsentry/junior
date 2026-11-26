/**
 * The cached GitHub issues and pull requests that cards read. Each entry
 * keeps the REST fields of one object that a card shows. A webhook merges
 * its payload into the entry, so the next card read needs no GitHub call.
 */
import type { PluginCache } from "@sentry/junior-plugin-api";
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

// A merge state that GitHub still computes stays fresh only this long, so
// the next read soon after asks GitHub again.
const GITHUB_PULL_REQUEST_PENDING_TTL_MS = 15_000;

/** How long a pull request entry with a pending merge state is fresh. */
export const GITHUB_PULL_REQUEST_PENDING_CACHE = {
  staleIfError: true,
  ttlMs: GITHUB_PULL_REQUEST_PENDING_TTL_MS,
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
  // GitHub's id of the object, which names it when its repository is
  // renamed. An entry that an older release cached has none.
  id: z.number().int().positive().optional(),
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
  requested_reviewers: z.array(person).optional(),
  // GitHub's review decision. Only the GraphQL card read has it, and a
  // webhook payload does not, so a webhook merge keeps it. `null` is a read
  // with no decision. Unset is not read yet, or cleared by a review webhook,
  // so the next page read asks GitHub (`pull-request-prefetch.ts`).
  review: z
    .enum(["approved", "changes_requested", "required"])
    .nullable()
    .optional(),
});

export type GitHubIssueFields = z.infer<typeof githubIssueFieldsSchema>;
export type GitHubPullRequestFields = z.infer<
  typeof githubPullRequestFieldsSchema
>;

/** The pull request fields without GitHub's review decision. */
export function withoutGitHubReview(
  fields: GitHubPullRequestFields,
): GitHubPullRequestFields {
  const { review: _, ...rest } = fields;
  return rest;
}

// A card read takes at most a page budget (`pull-request-prefetch.ts`), so
// a mark this old cannot overlap one.
const REVIEW_CLEARED_TTL_MS = 60_000;

function reviewClearedKey(key: string): string {
  return `review-cleared:${key}`;
}

/**
 * Record that a review webhook cleared the review decision of a pull
 * request entry. Call it before the entry write, so a card read that
 * GitHub answered before the change does not store the old decision
 * (`clearGitHubReviewAfterRead`).
 */
export async function markGitHubReviewCleared(
  cache: PluginCache,
  key: string,
): Promise<void> {
  await cache.update<number>(reviewClearedKey(key), () => ({
    ttlMs: REVIEW_CLEARED_TTL_MS,
    value: Date.now(),
  }));
}

/**
 * Clear the review decision that a card read started at `startedAtMs`
 * stored, when a review webhook came since. The read writes first and
 * checks after, so a webhook either comes before the check, which clears
 * the decision here, or clears it itself after the write.
 */
export async function clearGitHubReviewAfterRead(
  cache: PluginCache,
  key: string,
  startedAtMs: number,
): Promise<void> {
  const clearedAt = await cache.get<number>(reviewClearedKey(key));
  if (clearedAt === undefined || clearedAt < startedAtMs) return;
  await cache.update<GitHubPullRequestFields | null>(key, (current) =>
    current?.review === undefined
      ? undefined
      : { ...GITHUB_PULL_REQUEST_CACHE, value: withoutGitHubReview(current) },
  );
}

/**
 * The cache entry of pull request fields read from GitHub. An open pull
 * request whose merge state GitHub still computes shows pending, briefly.
 */
export function githubPullRequestEntry(fields: GitHubPullRequestFields) {
  return fields.state === "open" && fields.mergeable === null
    ? {
        ...GITHUB_PULL_REQUEST_PENDING_CACHE,
        value: { ...fields, mergeable: "pending" as const },
      }
    : { ...GITHUB_PULL_REQUEST_CACHE, value: fields };
}

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

/**
 * Clear a conflict that the pull request entry still knows for `headSha`,
 * after a read that is not the entry's own, such as a webhook or heartbeat
 * merge conflict check, finds it mergeable. Otherwise the next push marks
 * the fixed conflict again from the entry (`webhooks/object-cache.ts`).
 */
export async function clearGitHubCachedConflict(
  cache: PluginCache,
  ref: { number: number; repositoryFullName: string },
  headSha: string,
): Promise<void> {
  await cache.update<GitHubPullRequestFields | null>(
    githubObjectCacheKey("pulls", ref.repositoryFullName, ref.number),
    (current) =>
      current?.mergeable === false && current.head?.sha === headSha
        ? {
            ...GITHUB_PULL_REQUEST_CACHE,
            value: { ...current, mergeable: true },
          }
        : undefined,
  );
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
 * the object is cached as gone or the payload is older than the cached one.
 */
export function mergeGitHubObject<
  T extends GitHubIssueFields | GitHubPullRequestFields,
>(current: T | null | undefined, payload: T): T | undefined {
  // A late delivery from before a delete must not bring the object back.
  if (current === null) return undefined;
  if (isOlderGitHubObject(current, payload)) return undefined;
  return { ...current, ...payload };
}

/**
 * Merge a pull request webhook into its entry, and say whether its merge
 * state and checks need a patch. GitHub computes the merge state for one
 * head commit and base branch, and checks for the head commit only. After
 * a push, both turn `pending` until the patch reads them. After a new base,
 * only the merge state does, and known checks stay. On the same pair,
 * `mergeable: null` is a missing field: known values stay, and only values
 * that are not known yet turn `pending`. Only an open pull
 * request shows them, so only an open one gets a patch. Keep this decision
 * here, so a later policy can change it in one place.
 */
export function mergeGitHubPullRequest(
  current: GitHubPullRequestFields | null | undefined,
  payload: GitHubPullRequestFields,
): { fields: GitHubPullRequestFields; patch: boolean } | undefined {
  const fields = mergeGitHubObject(current, payload);
  if (!fields) return undefined;
  const changed = (before?: string, after?: string) =>
    before !== undefined && after !== undefined && before !== after;
  const newHead = changed(current?.head?.sha, payload.head?.sha);
  const newPair = newHead || changed(current?.base?.ref, payload.base?.ref);
  if (fields.state !== "open") return { fields, patch: false };
  if (!newPair) {
    if (payload.mergeable !== null) return { fields, patch: false };
    const known = current?.mergeable;
    if (typeof known === "boolean") {
      return { fields: { ...fields, mergeable: known }, patch: false };
    }
  }
  return {
    fields: {
      ...fields,
      checks: newHead ? "pending" : (fields.checks ?? "pending"),
      mergeable: "pending",
    },
    patch: true,
  };
}
