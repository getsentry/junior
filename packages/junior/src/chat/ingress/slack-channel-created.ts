import type { SlackAdapter } from "@chat-adapter/slack";
import type { StateAdapter } from "chat";
import { z } from "zod";
import { joinPublicChannel } from "@/chat/slack/channel";
import {
  runWithSlackInstallation,
  type SlackInstallationContext,
} from "@/chat/slack/adapter-context";
import { slackChannelIdSchema, type SlackChannelId } from "@/chat/slack/ids";
import { runWithWorkspaceTeamId } from "@/chat/slack/workspace-context";

// `channel` is an object here, unlike message events, so this event has its
// own envelope schema. Slack sends it only for new public channels.
// https://docs.slack.dev/reference/events/channel_created
export const slackChannelCreatedEnvelopeSchema = z.object({
  type: z.literal("event_callback"),
  team_id: z.string().optional(),
  enterprise_id: z.string().optional(),
  is_enterprise_install: z.boolean().optional(),
  event: z.object({
    type: z.literal("channel_created"),
    channel: z.looseObject({ id: slackChannelIdSchema }),
  }),
});

/** Join a newly created public channel for the installation that sent it. */
export async function joinCreatedSlackChannel(args: {
  adapter: SlackAdapter;
  channelId: SlackChannelId;
  installation: SlackInstallationContext;
  state: StateAdapter;
}): Promise<void> {
  await args.state.connect();
  await runWithWorkspaceTeamId(args.installation.teamId, () =>
    runWithSlackInstallation({
      adapter: args.adapter,
      installation: args.installation,
      state: args.state,
      task: () => joinPublicChannel(args.channelId),
    }),
  );
}
