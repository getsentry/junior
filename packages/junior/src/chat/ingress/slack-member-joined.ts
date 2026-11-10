import type { SlackAdapter } from "@chat-adapter/slack";
import type { StateAdapter } from "chat";
import * as z from "zod";
import { getConversationStore } from "@/chat/db";
import { getConversationInfo } from "@/chat/slack/channel";
import {
  runWithSlackInstallation,
  type SlackInstallationContext,
} from "@/chat/slack/adapter-context";
import {
  conversationVisibilityFromSlackChannelType,
  slackChannelTypeFromConversationInfo,
} from "@/chat/slack/conversation-context";
import { slackChannelIdSchema, type SlackChannelId } from "@/chat/slack/ids";
import { runWithWorkspaceTeamId } from "@/chat/slack/workspace-context";

// Slack sends this event when a member joins a channel that the bot is in.
// Only Junior's own join matters here. Its `channel_type` is the ID prefix,
// not the visibility, so the handler reads visibility from
// `conversations.info`.
// https://docs.slack.dev/reference/events/member_joined_channel
export const slackMemberJoinedEnvelopeSchema = z.object({
  type: z.literal("event_callback"),
  team_id: z.string().optional(),
  enterprise_id: z.string().optional(),
  is_enterprise_install: z.boolean().optional(),
  event: z.object({
    type: z.literal("member_joined_channel"),
    user: z.string(),
    channel: slackChannelIdSchema,
  }),
});

/**
 * Store the visibility of a channel when Junior joins it, so the Destination
 * exists before the first Turn there. Joins of other members are ignored.
 */
export async function recordJoinedSlackChannelVisibility(args: {
  adapter: SlackAdapter;
  channelId: SlackChannelId;
  installation: SlackInstallationContext;
  state: StateAdapter;
  userId: string;
}): Promise<void> {
  await args.state.connect();
  await runWithWorkspaceTeamId(args.installation.teamId, () =>
    runWithSlackInstallation({
      adapter: args.adapter,
      installation: args.installation,
      state: args.state,
      task: async () => {
        const teamId = args.installation.teamId;
        if (!teamId || args.userId !== args.adapter.botUserId) {
          return;
        }
        const info = await getConversationInfo(args.channelId);
        const visibility = conversationVisibilityFromSlackChannelType(
          slackChannelTypeFromConversationInfo(info),
        );
        if (!visibility) {
          return;
        }
        await getConversationStore().recordDestinationVisibility({
          destination: { platform: "slack", teamId, channelId: args.channelId },
          // A private channel name stays out of the name directory.
          ...(visibility === "public" && info.name
            ? { channelName: info.name }
            : undefined),
          visibility,
        });
      },
    }),
  );
}
