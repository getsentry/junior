import type {
  Actor,
  Identity,
  PluginLogger,
  User,
} from "@sentry/junior-plugin-api";

/**
 * Resolve the Junior identity id of the current Actor, to save as a pull
 * request requester. System actors and actors without a stored identity have
 * none. A failed lookup also gives none, so a pull request write never fails
 * only because of it.
 */
export async function resolveGitHubPullRequestRequester(ctx: {
  actor?: Actor;
  log: PluginLogger;
  users: {
    resolveActor(): Promise<{ identity?: Identity; user?: User } | undefined>;
  };
}): Promise<string | undefined> {
  if (!ctx.actor || ctx.actor.platform === "system") return undefined;
  try {
    return (await ctx.users.resolveActor())?.identity?.id;
  } catch (error) {
    ctx.log.warn("github.pull_request.requester.resolve_actor.failed", {
      "exception.message":
        error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}
