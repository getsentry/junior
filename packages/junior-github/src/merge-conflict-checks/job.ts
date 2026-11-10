/**
 * The plugin job that checks a repository's open Junior pull requests for
 * merge conflicts. GraphQL search reads them all with their mergeability.
 * Only a conflict that a Watch or event automation wants publishes
 * `pull_request.merge_conflict`. No agent runs for the check.
 */
import type {
  EventPublisher,
  PluginJobScheduler,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import { gitHubMergeConflictEvents } from "../webhooks/merge-conflict.js";

/** The registered job name. */
export const MERGE_CONFLICT_CHECK_JOB = "checkMergeConflicts";

/** Time to wait for GitHub to calculate mergeability. */
const UNKNOWN_RETRY_MS = 60_000;

/** Checks after one push. Each unknown answer uses one. */
const MAX_ATTEMPTS = 5;

/** Search pages per check, at 100 pull requests per page. */
const MAX_PAGES = 5;

/** The job payload. */
const mergeConflictCheckPayloadSchema = z.object({
  attempt: z.number().int().positive(),
  repositoryFullName: z.string().min(1),
});

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

type SearchOpenPullRequests = (input: {
  after?: string;
  author: string;
  repositoryFullName: string;
}) => Promise<unknown>;

/**
 * Check one repository, and publish its conflicts. When GitHub has not
 * calculated mergeability for a pull request yet, schedule another check.
 */
export async function runGitHubMergeConflictCheck(args: {
  /** The GitHub search author for Junior's pull requests, such as `app/x`. */
  author: string;
  events: EventPublisher;
  jobs: PluginJobScheduler;
  payload: unknown;
  search: SearchOpenPullRequests;
}): Promise<void> {
  const { attempt, repositoryFullName } = mergeConflictCheckPayloadSchema.parse(
    args.payload,
  );
  let unknown = false;
  let after: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const { search } = searchResponseSchema.parse(
      await args.search({ after, author: args.author, repositoryFullName }),
    ).data;
    for (const node of search.nodes) {
      if (!node || !("number" in node) || node.state !== "OPEN") continue;
      if (node.mergeable === "UNKNOWN") unknown = true;
      if (node.mergeable !== "CONFLICTING") continue;
      const events = gitHubMergeConflictEvents({
        conflict: {
          baseBranch: node.baseRefName,
          headSha: node.headRefOid,
          url: node.url,
        },
        number: node.number,
        repositoryFullName,
      });
      // Conflict events match only `repo` and `pullRequest`.
      if (!(await args.events.hasMatch?.(events))) continue;
      for (const event of events) await args.events.publish(event);
    }
    if (!search.pageInfo.hasNextPage || !search.pageInfo.endCursor) break;
    after = search.pageInfo.endCursor;
  }
  if (unknown && attempt < MAX_ATTEMPTS) {
    await args.jobs.schedule({
      delayMs: UNKNOWN_RETRY_MS,
      name: MERGE_CONFLICT_CHECK_JOB,
      payload: { attempt: attempt + 1, repositoryFullName },
    });
  }
}
