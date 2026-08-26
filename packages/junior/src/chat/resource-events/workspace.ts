import type { Destination } from "@sentry/junior-plugin-api";
import { getSlackBotToken } from "@/chat/config";
import { getSlackClient } from "@/chat/slack/client";

/** Return whether provider events can be bound to one Slack workspace. */
export function canRouteResourceEvents(): boolean {
  return Boolean(getSlackBotToken());
}

/**
 * Workspace team id used only to scope resource-event match indexes.
 *
 * This is not delivery routing. Watches store the id for match fanout; the
 * conversation binding still owns destination and provider for turns.
 */
export function resourceEventIndexTeamId(
  destination: Destination,
): string | undefined {
  if (destination.platform !== "slack") {
    return undefined;
  }
  const teamId = destination.teamId.trim();
  return teamId || undefined;
}

/** Resolve and cache the Slack workspace owned by this app instance. */
export function createResourceEventTeamIdResolver(): () => Promise<
  string | undefined
> {
  let pending: Promise<string> | undefined;
  return async () => {
    if (!canRouteResourceEvents()) return undefined;
    pending ??= getSlackClient()
      .auth.test()
      .then((result) => {
        const teamId = result.team_id?.trim();
        if (!teamId) {
          throw new Error("Slack auth.test did not return a workspace team id");
        }
        return teamId;
      })
      .catch((error) => {
        pending = undefined;
        throw error;
      });
    return await pending;
  };
}
