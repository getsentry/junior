import type { CallAudience } from "@sentry/junior-plugin-api";

/** Read `owner/repo` from a GitHub URL, such as `https://github.com/o/r.git`. */
function urlRepo(url: URL): string | undefined {
  if (url.hostname.toLowerCase() !== "github.com") {
    return undefined;
  }
  const match = /^\/([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url.pathname);
  return match?.[1];
}

/**
 * The repository behind a GitHub URL. Junior stores no visibility for a
 * repository, so its audience is `world`.
 */
export async function describeGitHubUrl(
  url: URL,
): Promise<{ ref: string; audience: CallAudience } | undefined> {
  const repo = urlRepo(url);
  return repo ? { ref: repo, audience: "world" } : undefined;
}
