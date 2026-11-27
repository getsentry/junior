/**
 * Read pull requests by repository and number in aliased GraphQL queries,
 * and read the answers into the cached REST fields, so a card reads the
 * same entry whether one REST read or one query for many pull requests
 * filled it.
 */
import * as z from "zod";
import type { GitHubPullRequestFields } from "./object-cache.js";
import { githubErrorMessage } from "./tool-support/github-api.js";

// Each pull request reads its head commit's check counts, and a card also
// its review requests, so a query stays small enough for GitHub's time
// limit. Craft reads pull requests in its changelog the same way.
const PULL_REQUESTS_PER_QUERY = 25;

/** One pull request that an aliased query reads. */
export interface PullRequestRef {
  name: string;
  number: number;
  owner: string;
}

/**
 * The pull request of a `pulls:owner/repo#N` cache key, or undefined for
 * any other key.
 */
export function pullRequestRefFromCacheKey(
  key: string,
): PullRequestRef | undefined {
  const match = /^pulls:([^/#]+)\/([^/#]+)#(\d+)$/.exec(key);
  if (!match?.[1] || !match[2] || !match[3]) return undefined;
  return { name: match[2], number: Number(match[3]), owner: match[1] };
}

/** Split pull requests into the chunks that one query reads each. */
export function pullRequestChunks<T>(items: T[]): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += PULL_REQUESTS_PER_QUERY) {
    chunks.push(items.slice(start, start + PULL_REQUESTS_PER_QUERY));
  }
  return chunks;
}

/** The variables of an aliased query for `refs`, in their order. */
export function pullRequestVariables(
  refs: PullRequestRef[],
): Record<string, number | string> {
  const variables: Record<string, number | string> = {};
  for (const [index, ref] of refs.entries()) {
    variables[`owner${index}`] = ref.owner;
    variables[`name${index}`] = ref.name;
    variables[`number${index}`] = ref.number;
  }
  return variables;
}

// A pull request that GitHub cannot read is null, with an error, and the
// others still come. No data at all means that the query failed.
const aliasedResponseSchema = z.object({
  data: z
    .record(z.string(), z.object({ pullRequest: z.unknown() }).nullable())
    .nullable(),
});

/**
 * Read the answer of an aliased query for `count` pull requests. Item `i`
 * is the pull request of alias `p<i>` that parses, or undefined. Throw when
 * the query failed.
 */
export function aliasedPullRequests<T>(
  body: unknown,
  count: number,
  schema: z.ZodType<T>,
): Array<T | undefined> {
  const { data } = aliasedResponseSchema.parse(body);
  if (!data) {
    throw new Error(
      `GitHub pull request query failed: ${githubErrorMessage(body)}`,
    );
  }
  return Array.from({ length: count }, (_, index) => {
    const parsed = schema.safeParse(data[`p${index}`]?.pullRequest);
    return parsed.success ? parsed.data : undefined;
  });
}

const stateCount = z.object({
  count: z.number().int().nonnegative(),
  state: z.string(),
});
const rollupSchema = z
  .object({
    contexts: z.object({
      checkRunCountsByState: z.array(stateCount).nullable().optional(),
    }),
  })
  .nullable();
const commitsSchema = z.object({
  nodes: z
    .array(
      z
        .object({ commit: z.object({ statusCheckRollup: rollupSchema }) })
        .nullable(),
    )
    .nullable(),
});

/** One pull request of `pullRequestHeadFacts`. */
export const pullRequestHeadFactsNodeSchema = z.object({
  commits: commitsSchema,
  headRefOid: z.string(),
  mergeable: z.enum(["CONFLICTING", "MERGEABLE", "UNKNOWN"]),
  updatedAt: z.string(),
});

/** One pull request of `pullRequestCards`. */
export const pullRequestCardNodeSchema = pullRequestHeadFactsNodeSchema.extend({
  additions: z.number().int().nonnegative(),
  author: z.object({ login: z.string() }).nullable(),
  baseRefName: z.string(),
  body: z.string(),
  changedFiles: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  headRefName: z.string(),
  isDraft: z.boolean(),
  merged: z.boolean(),
  number: z.number().int().positive(),
  reviewRequests: z
    .object({
      nodes: z
        .array(
          z
            .object({
              requestedReviewer: z
                .object({ login: z.string().optional() })
                .nullable(),
            })
            .nullable(),
        )
        .nullable(),
    })
    .nullable(),
  reviewDecision: z
    .enum(["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"])
    .nullish(),
  latestOpinionatedReviews: z
    .object({ nodes: z.array(z.object({ state: z.string() }).nullable()) })
    .nullish(),
  state: z.enum(["CLOSED", "MERGED", "OPEN"]),
  title: z.string(),
  url: z.string(),
});

/**
 * Return GitHub's review decision. A repository that requires no review has
 * none, so the latest review of each writer decides: approved when one
 * approves and none asks for changes.
 */
function pullRequestReview(
  node: z.output<typeof pullRequestCardNodeSchema>,
): GitHubPullRequestFields["review"] {
  if (node.reviewDecision === "APPROVED") return "approved";
  if (node.reviewDecision === "CHANGES_REQUESTED") return "changes_requested";
  if (node.reviewDecision === "REVIEW_REQUIRED") return "required";
  const states = (node.latestOpinionatedReviews?.nodes ?? []).map(
    (review) => review?.state,
  );
  if (states.includes("CHANGES_REQUESTED")) return "changes_requested";
  return states.includes("APPROVED") ? "approved" : null;
}

const PASSED_CHECK_RUNS = new Set(["NEUTRAL", "SKIPPED", "SUCCESS"]);
const PENDING_CHECK_RUNS = new Set([
  "IN_PROGRESS",
  "PENDING",
  "QUEUED",
  "REQUESTED",
  "WAITING",
]);

/** Count the check runs of a head commit as a card shows them. */
export function githubCheckCounts(
  commits: z.output<typeof commitsSchema>,
): NonNullable<Exclude<GitHubPullRequestFields["checks"], "pending">> {
  const counts = { failed: 0, passed: 0, pending: 0 };
  const contexts = commits.nodes?.[0]?.commit.statusCheckRollup?.contexts;
  for (const { count, state } of contexts?.checkRunCountsByState ?? []) {
    if (PASSED_CHECK_RUNS.has(state)) counts.passed += count;
    else if (PENDING_CHECK_RUNS.has(state)) counts.pending += count;
    else counts.failed += count;
  }
  return counts;
}

/** `null` while GitHub computes the merge state. */
export function githubMergeable(
  value: z.output<typeof pullRequestHeadFactsNodeSchema>["mergeable"],
): boolean | null {
  return value === "UNKNOWN" ? null : value === "MERGEABLE";
}

/** Read one `pullRequestCards` pull request into the cached REST fields. */
export function githubPullRequestFieldsFromNode(
  node: z.output<typeof pullRequestCardNodeSchema>,
): GitHubPullRequestFields {
  return {
    additions: node.additions,
    base: { ref: node.baseRefName },
    body: node.body,
    changed_files: node.changedFiles,
    checks: githubCheckCounts(node.commits),
    deletions: node.deletions,
    draft: node.isDraft,
    head: { ref: node.headRefName, sha: node.headRefOid },
    html_url: node.url,
    mergeable: githubMergeable(node.mergeable),
    merged: node.merged,
    number: node.number,
    requested_reviewers: (node.reviewRequests?.nodes ?? []).flatMap(
      (request) => {
        const login = request?.requestedReviewer?.login;
        return login ? [{ login }] : [];
      },
    ),
    // `null` when there is none, so a read replaces a decision that GitHub
    // dropped, such as a dismissed review, and marks the review read.
    review: pullRequestReview(node),
    state: node.state === "OPEN" ? "open" : "closed",
    title: node.title,
    updated_at: node.updatedAt,
    user: node.author && { login: node.author.login },
  };
}
