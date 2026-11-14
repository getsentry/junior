import { getSlackBotToken } from "@/chat/config";
import { getSlackClient } from "@/chat/slack/client";

// The team of a bot token never changes, so each token is looked up once.
const teamIdsByToken = new Map<string, Promise<string>>();

/**
 * Resolve the single-bot Slack team id for event-automation indexing, Event
 * people mentions, and author trust.
 *
 * Watch matching does not use this. Event automations still key by
 * destination team until that store is conversation-owned. System Events are
 * not gated on Slack. Without a Slack bot, only a listed Event author is
 * trusted.
 */
export async function resolveBotSlackTeamId(): Promise<string | undefined> {
  // Event automations and Event people need a Slack team key.
  const token = getSlackBotToken();
  if (!token) return undefined;
  let pending = teamIdsByToken.get(token);
  if (!pending) {
    pending = getSlackClient()
      .auth.test()
      .then((result) => {
        const teamId = result.team_id?.trim();
        if (!teamId) {
          throw new Error("Slack auth.test did not return a team id");
        }
        return teamId;
      });
    teamIdsByToken.set(token, pending);
    pending.catch(() => teamIdsByToken.delete(token));
  }
  return await pending;
}
