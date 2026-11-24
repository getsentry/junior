/**
 * Load the cards of a page of pull request links by repository and number,
 * at most 25 pull requests per GraphQL query, before each card reads its
 * cache entry. Only pull requests with no fresh entry are read. A link that
 * this skips reads its entry as usual.
 */
import type { ObjectLinkContext } from "@sentry/junior-plugin-api";
import pLimit, { type LimitFunction } from "p-limit";
import * as z from "zod";
import { pullRequestCards } from "./graphql-documents.js";
import {
  GITHUB_PULL_REQUEST_CACHE,
  type GitHubPullRequestFields,
  githubObjectCacheKey,
  isOlderGitHubObject,
} from "./object-cache.js";
import { scheduleGitHubPullRequestPatch } from "./pull-request-patches.js";
import {
  githubPullRequestFieldsFromNode,
  pullRequestCardNodeSchema,
} from "./pull-request-graphql.js";
import { viewerCanSeeRepository } from "./repository-access.js";
import { githubApi, githubErrorMessage } from "./tool-support/github-api.js";

// Cache and access reads, and card queries, that one prefetch runs at once.
const PREFETCH_CONCURRENCY = 10;

// Each pull request reads its review requests and its head commit's check
// counts, so a query stays small enough for GitHub's time limit. Craft
// reads pull requests in its changelog the same way.
const PULL_REQUESTS_PER_QUERY = 25;

// GitHub fails a GraphQL query after about 10 s. The page waits for this
// read before its cards, so a hung request stops at the same time, and its
// chunk splits.
const QUERY_TIMEOUT_MS = 10_000;

// A pull request that GitHub cannot read is null, with an error, and the
// others still come. No data at all means that the query failed.
const cardsResponseSchema = z.object({
  data: z
    .record(z.string(), z.object({ pullRequest: z.unknown() }).nullable())
    .nullable(),
});

interface PullRequestRef {
  name: string;
  number: number;
  owner: string;
}

function cacheKey(ref: PullRequestRef): string {
  return githubObjectCacheKey("pulls", `${ref.owner}/${ref.name}`, ref.number);
}

// The cache entries that are not fresh, of repositories the viewer sees.
async function missingRefs(
  ctx: ObjectLinkContext,
  refs: PullRequestRef[],
): Promise<PullRequestRef[]> {
  const missing = await pLimit(PREFETCH_CONCURRENCY).map(refs, async (ref) => {
    if ((await ctx.cache.get(cacheKey(ref))) !== undefined) return false;
    return await viewerCanSeeRepository(ctx, ref);
  });
  return refs.filter((_, index) => missing[index]);
}

async function storeCard(
  ctx: ObjectLinkContext,
  key: string,
  node: z.output<typeof pullRequestCardNodeSchema>,
): Promise<void> {
  const fields = githubPullRequestFieldsFromNode(node);
  // GitHub still computes the merge state, so it shows pending until a
  // patch reads it.
  const computing = fields.mergeable === null && fields.state === "open";
  let patchNodeId: string | undefined;
  await ctx.cache.update<GitHubPullRequestFields | null>(key, (current) => {
    if (isOlderGitHubObject(current, fields)) return undefined;
    if (!computing) {
      return {
        ...GITHUB_PULL_REQUEST_CACHE,
        value: { ...current, ...fields },
      };
    }
    patchNodeId = node.id;
    return {
      ...GITHUB_PULL_REQUEST_CACHE,
      value: { ...current, ...fields, mergeable: "pending" },
    };
  });
  if (patchNodeId) {
    await scheduleGitHubPullRequestPatch({
      key,
      nodeId: patchNodeId,
      nowMs: Date.now(),
      state: ctx.state,
    });
  }
}

async function loadChunk(
  ctx: ObjectLinkContext,
  refs: PullRequestRef[],
): Promise<void> {
  const variables: Record<string, number | string> = {};
  for (const [index, ref] of refs.entries()) {
    variables[`owner${index}`] = ref.owner;
    variables[`name${index}`] = ref.name;
    variables[`number${index}`] = ref.number;
  }
  const response = await githubApi(ctx.egress, {
    body: { ...pullRequestCards(refs.length), variables },
    method: "POST",
    operation: "github.pull.get",
    path: "/graphql",
    signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(
      `GitHub pull request cards lookup failed with HTTP ${response.status}`,
    );
  }
  const { data } = cardsResponseSchema.parse(response.body);
  if (!data) {
    throw new Error(
      `GitHub pull request cards lookup failed: ${githubErrorMessage(response.body)}`,
    );
  }
  await pLimit(PREFETCH_CONCURRENCY).map(refs, async (ref, index) => {
    const node = pullRequestCardNodeSchema.safeParse(
      data[`p${index}`]?.pullRequest,
    );
    if (node.success) await storeCard(ctx, cacheKey(ref), node.data);
  });
}

// A chunk that fails splits in halves, and the halves are its retry. A pull
// request that fails alone is skipped: its card reads on its own, and keeps
// its stale entry when that read fails too.
async function loadRefs(
  ctx: ObjectLinkContext,
  limit: LimitFunction,
  refs: PullRequestRef[],
): Promise<void> {
  try {
    await limit(() => loadChunk(ctx, refs));
  } catch (error) {
    const [only] = refs;
    if (only && refs.length === 1) {
      ctx.log.error(
        "GitHub pull request card query failed",
        { number: only.number, repository: `${only.owner}/${only.name}` },
        error,
      );
      return;
    }
    const half = Math.ceil(refs.length / 2);
    await Promise.all(
      [refs.slice(0, half), refs.slice(half)].map((part) =>
        loadRefs(ctx, limit, part),
      ),
    );
  }
}

/** Load the missing cards of the pull requests that `refs` name. */
export async function prefetchGitHubPullRequests(
  ctx: ObjectLinkContext,
  refs: PullRequestRef[],
): Promise<void> {
  const missing = await missingRefs(ctx, refs);
  const chunks: PullRequestRef[][] = [];
  for (
    let start = 0;
    start < missing.length;
    start += PULL_REQUESTS_PER_QUERY
  ) {
    chunks.push(missing.slice(start, start + PULL_REQUESTS_PER_QUERY));
  }
  // The queries of every chunk and of its halves share one limit.
  const queries = pLimit(PREFETCH_CONCURRENCY);
  await pLimit(PREFETCH_CONCURRENCY).map(chunks, (chunk) =>
    loadRefs(ctx, queries, chunk),
  );
}
