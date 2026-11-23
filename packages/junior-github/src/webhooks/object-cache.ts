import type { PluginCache } from "@sentry/junior-plugin-api";
import * as z from "zod";
import {
  GITHUB_OBJECT_CACHE,
  githubIssueFieldsSchema,
  githubObjectCacheKey,
  githubPullRequestFieldsSchema,
  mergeGitHubObject,
} from "../object-cache.js";

const repositorySchema = z.object({ full_name: z.string().min(1) });
const issueEventSchema = z.object({
  issue: githubIssueFieldsSchema,
  repository: repositorySchema,
});
const pullRequestEventSchema = z.object({
  pull_request: githubPullRequestFieldsSchema,
  repository: repositorySchema,
});

/**
 * Write the issue or pull request of an `issues` or `pull_request` webhook
 * into its cache entry, so the next card read shows it without a GitHub
 * call.
 */
export async function refreshGitHubObjectCache(args: {
  body: unknown;
  cache: PluginCache;
  eventName: string;
}): Promise<void> {
  const event =
    args.eventName === "issues"
      ? issueEventSchema.safeParse(args.body)
      : args.eventName === "pull_request"
        ? pullRequestEventSchema.safeParse(args.body)
        : undefined;
  if (!event?.success) return;
  const { repository } = event.data;
  const [collection, payload] =
    "issue" in event.data
      ? (["issues", event.data.issue] as const)
      : (["pulls", event.data.pull_request] as const);
  await args.cache.update<typeof payload | null>(
    githubObjectCacheKey(collection, repository.full_name, payload.number),
    (current) => {
      const value = mergeGitHubObject(current, payload);
      return value && { ...GITHUB_OBJECT_CACHE, value };
    },
  );
}
