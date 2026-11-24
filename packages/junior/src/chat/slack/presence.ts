import * as z from "zod";
import {
  getSlackClient,
  SlackActionError,
  withSlackRetries,
} from "@/chat/slack/client";

// https://docs.slack.dev/reference/methods/users.getPresence. For another
// user, Slack returns only `presence`.
const presenceSchema = z.object({ presence: z.enum(["active", "away"]) });

/**
 * Return whether a Slack user is active in Slack now, from
 * `users.getPresence`. Return undefined when Slack cannot answer.
 */
export async function isSlackUserActive(
  userId: string,
): Promise<boolean | undefined> {
  let response: unknown;
  try {
    response = await withSlackRetries(
      () => getSlackClient().users.getPresence({ user: userId }),
      3,
      { action: "users.getPresence", idempotent: true },
    );
  } catch (error) {
    // `withSlackRetries` already logged the Slack error.
    if (error instanceof SlackActionError) return undefined;
    throw error;
  }
  return presenceSchema.parse(response).presence === "active";
}
