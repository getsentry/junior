import { getSlackBotToken } from "@/chat/config";
import { getSlackClient } from "@/chat/slack/client";

/**
 * Resolve the single-bot Slack team id for event-automation indexing.
 *
 * Watches do not use this. Event automations still key by destination team
 * until that store is conversation-owned. Event delivery itself is
 * not gated on Slack.
 */
export function createEventTeamIdResolver(): () => Promise<string | undefined> {
  let pending: Promise<string> | undefined;
  return async () => {
    // Event automations still need a Slack team key. Watches do not.
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
