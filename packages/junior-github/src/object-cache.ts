/**
 * The cached GitHub issues and pull requests that cards read. Each entry
 * keeps the REST fields of one object that a card shows. A webhook merges
 * its payload into the entry, so the next card read needs no GitHub call.
 */
import * as z from "zod";

// Webhooks refresh a changed object, so the TTL bounds only a change that
// sends no webhook.
const OBJECT_CACHE_TTL_MS = 60_000;

/**
 * How long an object entry is fresh. When GitHub fails after the TTL, the
 * card keeps the last object read. The repository access check still
 * expires, so access is never extended.
 */
export const GITHUB_OBJECT_CACHE = {
  staleIfError: true,
  ttlMs: OBJECT_CACHE_TTL_MS,
} as const;

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

/** The fields of a pull request that its card reads. */
export const githubPullRequestFieldsSchema = z.object({
  ...objectFields,
  additions: z.number().int().nonnegative().optional(),
  base: z.object({ ref: z.string() }).optional(),
  changed_files: z.number().int().nonnegative().optional(),
  deletions: z.number().int().nonnegative().optional(),
  draft: z.boolean().optional(),
  head: z.object({ ref: z.string(), sha: z.string().optional() }).optional(),
  mergeable: z.boolean().nullable().optional(),
  merged: z.boolean().optional(),
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

/**
 * Merge webhook fields into a cached object. A field in the payload
 * replaces the cached one, and a missing field stays. Returns nothing when
 * the payload is older than the cached object.
 */
export function mergeGitHubObject<
  T extends GitHubIssueFields | GitHubPullRequestFields,
>(current: T | null | undefined, payload: T): T | undefined {
  if (
    current?.updated_at &&
    payload.updated_at &&
    Date.parse(payload.updated_at) < Date.parse(current.updated_at)
  ) {
    return undefined;
  }
  const merged = { ...current, ...payload };
  if (!("head" in merged) || !current || !("head" in current)) return merged;
  // GitHub computes mergeability for one head commit and base branch. After
  // a push or a new base, the cached value is about the old pair, so it is
  // unknown until GitHub sends or answers it again.
  if (
    current.head?.sha !== merged.head?.sha ||
    current.base?.ref !== merged.base?.ref
  ) {
    if (!("mergeable" in payload)) delete merged.mergeable;
  } else if (merged.mergeable === null) {
    // GitHub sends `mergeable: null` while it computes it, so it is a
    // missing field, not a new value.
    merged.mergeable = current.mergeable;
  }
  return merged;
}
