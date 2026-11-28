import * as z from "zod";
import { slackChannelIdSchema } from "@/chat/slack/ids";

// Slack sends this event both when a person leaves a channel and when
// someone removes them, for public and private channels.
// https://docs.slack.dev/reference/events/member_left_channel
export const slackMemberLeftChannelEnvelopeSchema = z.object({
  type: z.literal("event_callback"),
  team_id: z.string().min(1),
  event: z.object({
    type: z.literal("member_left_channel"),
    channel: slackChannelIdSchema,
    user: z.string().min(1),
  }),
});
