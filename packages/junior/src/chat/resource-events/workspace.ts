import { getSlackBotToken } from "@/chat/config";
import { getSlackClient } from "@/chat/slack/client";

/**
 * Whether this install can enable resource-event delivery.
 *
 * Single-bot installs use the Slack bot token as the install gate. Multi-bot
 * mode stays off until event delivery can bind without a single-bot assumption.
 */
export function canRouteResourceEvents(): boolean {
  return Boolean(getSlackBotToken());
}

/**
 * Resolve the single-bot Slack team id for event-task indexing.
 *
 * Resource watches do not use this. Event tasks still key by destination team
 * until that store is conversation-owned.
 */
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
          throw new Error("Slack auth.test did not return a team id");
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
