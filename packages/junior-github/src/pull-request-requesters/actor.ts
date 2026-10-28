import type {
  Actor,
  Identity,
  PluginLogger,
  User,
} from "@sentry/junior-plugin-api";
import { linkedGitHubLogin } from "../tool-support/attribution.js";
import type { GitHubPullRequestRequester } from "./store.js";

/**
 * Resolve the current Actor as a pull request requester. System actors and
 * actors without a stored identity have none. A failed lookup also gives
 * none, so a pull request write never fails only because of it. Webhooks
 * then use the pull request author.
 */
export async function resolveGitHubPullRequestRequester(ctx: {
  actor?: Actor;
  log: PluginLogger;
  users: {
    resolveActor(): Promise<{ identity?: Identity; user?: User } | undefined>;
  };
}): Promise<GitHubPullRequestRequester | undefined> {
  if (!ctx.actor || ctx.actor.platform === "system") return undefined;
  let resolved: { identity?: Identity; user?: User } | undefined;
  try {
    resolved = await ctx.users.resolveActor();
  } catch (error) {
    ctx.log.warn("github.pull_request.requester.resolve_actor.failed", {
      "exception.message":
        error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
  if (!resolved?.identity) return undefined;
  const githubLogin = linkedGitHubLogin(resolved.user);
  return {
    identityId: resolved.identity.id,
    ...(resolved.user ? { userId: resolved.user.id } : undefined),
    ...(githubLogin ? { githubLogin } : undefined),
  };
}
