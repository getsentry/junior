/**
 * Load the cards of a page of pull request links in one GraphQL query per
 * 100 pull requests, before each card reads its cache entry. Only pull
 * requests with a stored GraphQL id and no fresh entry are read. A link
 * that this skips reads its entry as usual.
 */
import type { ObjectLinkContext } from "@sentry/junior-plugin-api";
import { and, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import pLimit from "p-limit";
import { gitHubDbSchema } from "./db/database.js";
import { juniorGitHubPullRequests } from "./db/schema.js";
import { PULL_REQUEST_CARDS } from "./graphql-documents.js";
import {
  GITHUB_PULL_REQUEST_CACHE,
  type GitHubPullRequestFields,
  githubObjectCacheKey,
  isOlderGitHubObject,
} from "./object-cache.js";
import {
  GITHUB_NODES_MAX,
  githubPullRequestFieldsFromNode,
  githubPullRequestNodes,
  pullRequestCardNodeSchema,
} from "./pull-request-graphql.js";
import { viewerCanSeeRepository } from "./repository-access.js";
import { githubApi } from "./tool-support/github-api.js";

// Cache and access reads that one prefetch runs at once. Each GraphQL
// query covers up to 100 pull requests, so few run at once.
const PREFETCH_CONCURRENCY = 10;

interface PullRequestRef {
  name: string;
  number: number;
  owner: string;
}

// The cache entries that are not fresh, of repositories the viewer sees.
async function missingRefs(
  ctx: ObjectLinkContext,
  refs: PullRequestRef[],
): Promise<PullRequestRef[]> {
  const missing = await pLimit(PREFETCH_CONCURRENCY).map(refs, async (ref) => {
    const key = githubObjectCacheKey(
      "pulls",
      `${ref.owner}/${ref.name}`,
      ref.number,
    );
    if ((await ctx.cache.get(key)) !== undefined) return false;
    return await viewerCanSeeRepository(ctx, ref);
  });
  return refs.filter((_, index) => missing[index]);
}

async function storedNodeIds(
  ctx: ObjectLinkContext,
  refs: PullRequestRef[],
): Promise<Map<string, string>> {
  if (refs.length === 0) return new Map();
  const t = juniorGitHubPullRequests;
  const rows = await gitHubDbSchema
    .parse(ctx.db)
    .select({
      nodeId: t.nodeId,
      number: t.number,
      repositoryFullName: t.repositoryFullName,
    })
    .from(t)
    .where(and(isNotNull(t.nodeId), or(...refs.map(sameRepository))));
  // Key each id by the link's cache key, which the card reads.
  return new Map(
    rows.flatMap((row) =>
      row.nodeId
        ? [
            [
              row.nodeId,
              githubObjectCacheKey("pulls", row.repositoryFullName, row.number),
            ],
          ]
        : [],
    ),
  );
}

async function loadChunk(
  ctx: ObjectLinkContext,
  keysByNodeId: Map<string, string>,
  nodeIds: string[],
): Promise<void> {
  const response = await githubApi(ctx.egress, {
    body: { ...PULL_REQUEST_CARDS, variables: { ids: nodeIds } },
    method: "POST",
    operation: "github.pull.get",
    path: "/graphql",
  });
  if (!response.ok) {
    throw new Error(
      `GitHub pull request cards lookup failed with HTTP ${response.status}`,
    );
  }
  const nodes = githubPullRequestNodes(
    response.body,
    pullRequestCardNodeSchema,
  );
  await pLimit(PREFETCH_CONCURRENCY).map(nodes, async (node) => {
    const key = keysByNodeId.get(node.id);
    if (!key) return;
    const fields = githubPullRequestFieldsFromNode(node);
    await ctx.cache.update<GitHubPullRequestFields | null>(key, (current) =>
      isOlderGitHubObject(current, fields)
        ? undefined
        : { ...GITHUB_PULL_REQUEST_CACHE, value: { ...current, ...fields } },
    );
  });
}

function sameRepository(ref: PullRequestRef) {
  const t = juniorGitHubPullRequests;
  return and(
    eq(
      sql`lower(${t.repositoryFullName})`,
      `${ref.owner}/${ref.name}`.toLowerCase(),
    ),
    eq(t.number, ref.number),
  );
}

/**
 * Store the GraphQL id of a Junior pull request that has none yet, from a
 * card read of it. Rows from before Junior stored the id get it from this
 * read or the next webhook, and the batch skips them until then.
 */
export async function rememberGitHubPullRequestNodeId(
  ctx: ObjectLinkContext,
  ref: PullRequestRef,
  nodeId: string,
): Promise<void> {
  const t = juniorGitHubPullRequests;
  await gitHubDbSchema
    .parse(ctx.db)
    .update(t)
    .set({ nodeId })
    .where(and(isNull(t.nodeId), sameRepository(ref)));
}

/** Load the missing cards of the pull requests that `refs` name. */
export async function prefetchGitHubPullRequests(
  ctx: ObjectLinkContext,
  refs: PullRequestRef[],
): Promise<void> {
  const keysByNodeId = await storedNodeIds(ctx, await missingRefs(ctx, refs));
  const nodeIds = [...keysByNodeId.keys()];
  const chunks: string[][] = [];
  for (let start = 0; start < nodeIds.length; start += GITHUB_NODES_MAX) {
    chunks.push(nodeIds.slice(start, start + GITHUB_NODES_MAX));
  }
  await pLimit(PREFETCH_CONCURRENCY).map(chunks, (chunk) =>
    loadChunk(ctx, keysByNodeId, chunk),
  );
}
