import type { PluginHttpCache } from "@sentry/junior-plugin-api";

/**
 * Send one GET with an installation token, through saved responses. Without
 * it, a read sends the request as it is.
 */
export type GitHubResponses = (
  url: string,
  send: (headers: Record<string, string>) => Promise<Response>,
) => Promise<Response>;

/**
 * Read GitHub with installation tokens through Junior's HTTP cache. Each
 * read asks GitHub with the saved ETag. GitHub answers `304 Not Modified`
 * only to a request that it authorized, and does not count it against the
 * rate limit, so a repeat read of an unchanged resource, such as a pull
 * request that every check suite webhook reads, is free.
 */
export function installationResponses(
  cache: PluginHttpCache,
  installationId: () => string | undefined,
): GitHubResponses {
  return async (url, send) =>
    await cache.fetch({
      scope: `installation:${installationId() ?? ""}`,
      ttlMs: 0,
      url,
      send,
    });
}
