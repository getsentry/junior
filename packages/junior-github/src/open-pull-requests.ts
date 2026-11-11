/**
 * The open Junior pull requests of one repository, from a GitHub GraphQL
 * search. Merge conflict checks and the daily reconcile share this read.
 */
import * as z from "zod";

/** Search pages per read, at 100 pull requests per page. */
const MAX_PAGES = 5;

/** One search result. A result that is not a pull request has no fields. */
const searchNodeSchema = z.union([
  z.object({
    baseRefName: z.string().min(1),
    headRefOid: z.string().min(1),
    mergeable: z.enum(["CONFLICTING", "MERGEABLE", "UNKNOWN"]),
    number: z.number().int().positive(),
    state: z.string(),
    url: z.string().min(1),
  }),
  z.object({}).strict(),
]);

const searchResponseSchema = z.object({
  data: z.object({
    search: z.object({
      nodes: z.array(searchNodeSchema.nullable()),
      pageInfo: z.object({
        endCursor: z.string().nullable(),
        hasNextPage: z.boolean(),
      }),
    }),
  }),
});

/** Read one search page of a repository's open Junior pull requests. */
export type SearchOpenPullRequests = (input: {
  after?: string;
  repositoryFullName: string;
}) => Promise<unknown>;

/** One open pull request with its mergeability. */
export interface OpenGitHubPullRequest {
  baseRefName: string;
  headRefOid: string;
  mergeable: "CONFLICTING" | "MERGEABLE" | "UNKNOWN";
  number: number;
  url: string;
}

/**
 * Return the open Junior pull requests of one repository. The read stops
 * after 500 pull requests. `complete` is false when GitHub has more.
 */
export async function listOpenGitHubPullRequests(
  search: SearchOpenPullRequests,
  repositoryFullName: string,
): Promise<{ complete: boolean; pullRequests: OpenGitHubPullRequest[] }> {
  const pullRequests: OpenGitHubPullRequest[] = [];
  let after: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const { search: result } = searchResponseSchema.parse(
      await search({ after, repositoryFullName }),
    ).data;
    for (const node of result.nodes) {
      if (!node || !("number" in node) || node.state !== "OPEN") continue;
      pullRequests.push({
        baseRefName: node.baseRefName,
        headRefOid: node.headRefOid,
        mergeable: node.mergeable,
        number: node.number,
        url: node.url,
      });
    }
    if (!result.pageInfo.hasNextPage || !result.pageInfo.endCursor) {
      return { complete: true, pullRequests };
    }
    after = result.pageInfo.endCursor;
  }
  return { complete: false, pullRequests };
}
