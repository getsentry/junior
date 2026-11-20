import * as z from "zod";
import {
  getSlackClient,
  SlackActionError,
  withSlackRetries,
} from "@/chat/slack/client";

// https://docs.slack.dev/reference/methods/dnd.info. Slack returns 1 for both
// timestamps when Do Not Disturb is off. The `snooze_*` fields are returned
// only for the calling user, so a bot cannot see a manual pause.
const dndInfoSchema = z.object({
  dnd_enabled: z.boolean(),
  next_dnd_start_ts: z.number(),
  next_dnd_end_ts: z.number(),
});

/**
 * Return whether a Slack user's notification schedule pauses notifications
 * at `nowMs`, from `dnd.info`. Return undefined when Slack cannot answer,
 * such as before the install grants `dnd:read`.
 */
export async function isSlackDndActive(
  userId: string,
  nowMs: number,
): Promise<boolean | undefined> {
  let response: unknown;
  try {
    response = await withSlackRetries(
      () => getSlackClient().dnd.info({ user: userId }),
      3,
      { action: "dnd.info", idempotent: true },
    );
  } catch (error) {
    // `withSlackRetries` already logged the Slack error. The caller falls
    // back to the saved hours.
    if (error instanceof SlackActionError) return undefined;
    throw error;
  }
  const dnd = dndInfoSchema.parse(response);
  return (
    dnd.dnd_enabled &&
    nowMs >= dnd.next_dnd_start_ts * 1000 &&
    nowMs < dnd.next_dnd_end_ts * 1000
  );
}
