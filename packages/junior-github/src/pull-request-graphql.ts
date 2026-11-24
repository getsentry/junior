/**
 * Read GraphQL pull request nodes into the cached REST fields, so a card
 * reads the same entry whether one REST read or one query for many pull
 * requests filled it.
 */
import * as z from "zod";
import type { GitHubPullRequestFields } from "./object-cache.js";

/** GitHub reads at most this many ids in one `nodes` query. */
export const GITHUB_NODES_MAX = 100;

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

/** One node of `PULL_REQUEST_HEAD_FACTS`. */
export const pullRequestHeadFactsNodeSchema = z.object({
  commits: commitsSchema,
  headRefOid: z.string(),
  id: z.string(),
  mergeable: z.enum(["CONFLICTING", "MERGEABLE", "UNKNOWN"]),
  updatedAt: z.string(),
});

/** One node of `PULL_REQUEST_CARDS`. */
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
  state: z.enum(["CLOSED", "MERGED", "OPEN"]),
  title: z.string(),
  url: z.string(),
});

/**
 * Parse a `nodes` response. A node that is not a pull request, or that
 * GitHub could not read, is left out.
 */
export function githubPullRequestNodes<T>(
  body: unknown,
  schema: z.ZodType<T>,
): T[] {
  const nodes = z
    .object({ data: z.object({ nodes: z.array(z.unknown()) }) })
    .parse(body).data.nodes;
  return nodes.flatMap((node) => {
    const parsed = schema.safeParse(node);
    return parsed.success ? [parsed.data] : [];
  });
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

/** Read one `PULL_REQUEST_CARDS` node into the cached REST fields. */
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
    node_id: node.id,
    number: node.number,
    requested_reviewers: (node.reviewRequests?.nodes ?? []).flatMap(
      (request) => {
        const login = request?.requestedReviewer?.login;
        return login ? [{ login }] : [];
      },
    ),
    state: node.state === "OPEN" ? "open" : "closed",
    title: node.title,
    updated_at: node.updatedAt,
    user: node.author && { login: node.author.login },
  };
}
