import { getSlackBotToken } from "@/chat/config";
import { getSlackClient } from "@/chat/slack/client";

/**
 * Resolve the single-bot Slack team id for event-task indexing.
 *
 * Resource watches do not use this. Event tasks still key by destination team
 * until that store is conversation-owned. Resource-event delivery itself is
 * not gated on Slack.
 */
export function createResourceEventTeamIdResolver(): () => Promise<
  string | undefined
> {
  let pending: Promise<string> | undefined;
  return async () => {
    // Event tasks still need a Slack team key. Watches do not.
    if (!getSlackBotToken()) return undefined;
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
