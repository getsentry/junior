import type { Audience, DescribeReadContext } from "@sentry/junior-plugin-api";
import { repositoryAudience } from "./repository-audience.js";

/** Read the repository of a GitHub URL, such as `https://github.com/o/r.git`. */
function urlRepo(url: URL): { name: string; owner: string } | undefined {
  if (url.hostname.toLowerCase() !== "github.com") {
    return undefined;
  }
  const match = /^\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.pathname);
  return match ? { owner: match[1]!, name: match[2]! } : undefined;
}

/** The repository behind a GitHub URL, with its visibility as the audience. */
export async function describeGitHubUrl(
  url: URL,
  ctx: DescribeReadContext,
): Promise<{ ref: string; audience: Audience } | undefined> {
  const repo = urlRepo(url);
  return repo
    ? {
        ref: `${repo.owner}/${repo.name}`,
        audience: await repositoryAudience(ctx, repo),
      }
    : undefined;
}
