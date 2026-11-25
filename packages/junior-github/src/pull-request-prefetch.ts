/**
 * Load the cards of a page of pull request links by repository and number,
 * at most 25 pull requests per GraphQL query, before each card reads its
 * cache entry. Only pull requests with no fresh entry are read. A link that
 * this skips reads its entry as usual, unless the page's time ran out for
 * it.
 */
import type { ObjectLinkContext } from "@sentry/junior-plugin-api";
import pLimit, { type LimitFunction } from "p-limit";
import type * as z from "zod";
import { pullRequestCards } from "./graphql-documents.js";
import {
  type GitHubPullRequestFields,
  githubObjectCacheKey,
  githubPullRequestEntry,
  isOlderGitHubObject,
} from "./object-cache.js";
import {
  aliasedPullRequests,
  githubPullRequestFieldsFromNode,
  pullRequestCardNodeSchema,
  pullRequestChunks,
  type PullRequestRef,
  pullRequestVariables,
} from "./pull-request-graphql.js";
import { viewerCanSeeRepository } from "./repository-access.js";
import { githubApi } from "./tool-support/github-api.js";

// Cache and access reads, and card queries, that one prefetch runs at once.
const PREFETCH_CONCURRENCY = 10;

// GitHub fails a GraphQL query after about 10 s. The page waits for this
// read before its cards, so a hung request stops at the same time, and its
// chunk splits.
const QUERY_TIMEOUT_MS = 10_000;

// How long one page waits for all of its card queries. After that, nothing
// splits, and each card that is left shows its stale entry, or no card yet.
const PAGE_BUDGET_MS = 20_000;

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
  await ctx.cache.update<GitHubPullRequestFields | null>(key, (current) =>
    isOlderGitHubObject(current, fields)
      ? undefined
      : githubPullRequestEntry({ ...current, ...fields }),
  );
}

async function loadChunk(
  ctx: ObjectLinkContext,
  refs: PullRequestRef[],
  deadlineMs: number,
): Promise<void> {
  const leftMs = deadlineMs - Date.now();
  if (leftMs <= 0) throw new Error("The page has no time left for cards");
  const response = await githubApi(ctx.egress, {
    body: {
      ...pullRequestCards(refs.length),
      variables: pullRequestVariables(refs),
    },
    method: "POST",
    operation: "github.pull.get",
    path: "/graphql",
    signal: AbortSignal.timeout(Math.min(QUERY_TIMEOUT_MS, leftMs)),
  });
  if (!response.ok) {
    throw new Error(
      `GitHub pull request cards lookup failed with HTTP ${response.status}`,
    );
  }
  const nodes = aliasedPullRequests(
    response.body,
    refs.length,
    pullRequestCardNodeSchema,
  );
  await pLimit(PREFETCH_CONCURRENCY).map(refs, async (ref, index) => {
    const node = nodes[index];
    if (node) await storeCard(ctx, cacheKey(ref), node);
  });
}

// Run `load` on `items`. A failed run splits in halves, and the halves are
// its retry, while `canSplit` allows it. A run that cannot split goes to
// `failed`.
async function loadInHalves<T>(args: {
  canSplit(): boolean;
  failed(items: T[], error: unknown): Promise<void>;
  items: T[];
  load(items: T[]): Promise<void>;
}): Promise<void> {
  try {
    await args.load(args.items);
  } catch (error) {
    if (args.items.length === 1 || !args.canSplit()) {
      await args.failed(args.items, error);
      return;
    }
    const half = Math.ceil(args.items.length / 2);
    await Promise.all(
      [args.items.slice(0, half), args.items.slice(half)].map((items) =>
        loadInHalves({ ...args, items }),
      ),
    );
  }
}

// A chunk that fails splits in halves, and the halves are its retry. A pull
// request that fails alone is skipped: its card reads on its own, and keeps
// its stale entry when that read fails too. A chunk that fails after the
// page's time goes to `outOfTime`, so its cards do not read GitHub again.
async function loadRefs(
  ctx: ObjectLinkContext,
  limit: LimitFunction,
  refs: PullRequestRef[],
  deadlineMs: number,
  outOfTime: PullRequestRef[],
): Promise<void> {
  await loadInHalves({
    canSplit: () => Date.now() < deadlineMs,
    failed: async (failed, error) => {
      if (Date.now() >= deadlineMs) {
        outOfTime.push(...failed);
        return;
      }
      const [only] = failed;
      if (only) {
        ctx.log.error(
          "GitHub pull request card query failed",
          { number: only.number, repository: `${only.owner}/${only.name}` },
          error,
        );
      }
    },
    items: refs,
    load: async (part) => await limit(() => loadChunk(ctx, part, deadlineMs)),
  });
}

/**
 * Load the missing cards of the pull requests that `refs` name. Returns
 * the ones that the page's time ran out for.
 */
export async function prefetchGitHubPullRequests(
  ctx: ObjectLinkContext,
  refs: PullRequestRef[],
): Promise<PullRequestRef[]> {
  const deadlineMs = Date.now() + PAGE_BUDGET_MS;
  const chunks = pullRequestChunks(await missingRefs(ctx, refs));
  // The queries of every chunk and of its halves share one limit.
  const queries = pLimit(PREFETCH_CONCURRENCY);
  const outOfTime: PullRequestRef[] = [];
  await pLimit(PREFETCH_CONCURRENCY).map(chunks, (chunk) =>
    loadRefs(ctx, queries, chunk, deadlineMs, outOfTime),
  );
  return outOfTime;
}
