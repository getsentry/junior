import type { PluginCache } from "@sentry/junior-plugin-api";
import * as z from "zod";
import { githubObjectCacheKey } from "../issue-links.js";

const objectNumber = z.object({ number: z.number().int().positive() });
const objectEventSchema = z.object({
  issue: objectNumber.optional(),
  pull_request: objectNumber.optional(),
  repository: z.object({ full_name: z.string().min(1) }),
});

/**
 * Clear the cached issue or pull request that an `issues` or `pull_request`
 * webhook changed, so the next card read loads it from GitHub.
 */
export async function clearGitHubObjectCache(args: {
  body: unknown;
  cache: PluginCache;
  eventName: string;
}): Promise<void> {
  if (args.eventName !== "issues" && args.eventName !== "pull_request") {
    return;
  }
  const parsed = objectEventSchema.safeParse(args.body);
  if (!parsed.success) return;
  const { issue, pull_request: pullRequest, repository } = parsed.data;
  const number = (args.eventName === "issues" ? issue : pullRequest)?.number;
  if (!number) return;
  // The issue URL of a pull request caches the pull request card too.
  await args.cache.delete(
    githubObjectCacheKey("issues", repository.full_name, number),
  );
  if (args.eventName === "pull_request") {
    await args.cache.delete(
      githubObjectCacheKey("pulls", repository.full_name, number),
    );
  }
}
