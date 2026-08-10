import { joinPublicChannel } from "@/chat/slack/channel";
import { SlackActionError } from "@/chat/slack/client";
import {
  checkSlackChannelReadAccess,
  type DestinationVisibilityReader,
  type SlackChannelJoinWriter,
  type SlackConversationInfoReader,
} from "@/chat/slack/tools/channel-access";
import {
  optionalSlackChannelIdParam,
  optionalSlackChannelNameParam,
  resolveSlackChannelTarget,
  type SlackChannelNameResolver,
} from "@/chat/slack/tools/channel-target";
import type { SlackToolContext } from "@/chat/slack/tools/context";
import { z } from "zod";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";

/** Create a tool that joins one public Slack channel on demand. */
export function createSlackChannelJoinTool(
  context: SlackToolContext,
  deps: {
    conversationInfo?: SlackConversationInfoReader;
    joinChannel?: SlackChannelJoinWriter;
    nameResolver?: SlackChannelNameResolver;
    visibilityStore?: DestinationVisibilityReader;
  } = {},
) {
  return zodTool({
    description:
      "Join one public Slack channel on demand so Junior can read its history or threads. Use when a linked public thread or channel history fails because the bot is not in the channel, or when the user asks Junior to join a public channel. Do not join channels preemptively and never join private channels or DMs.",
    annotations: {
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
      readOnlyHint: false,
    },
    inputSchema: z.object({
      channel_id: optionalSlackChannelIdParam(
        "Public Slack channel ID to join (for example C123).",
      ),
      channel_name: optionalSlackChannelNameParam(
        "Public channel name with or without a leading #. Use when the user names the channel.",
      ),
    }),
    outputSchema: juniorToolOutputSchema,
    execute: async ({ channel_id, channel_name }) => {
      if (channel_id === undefined && channel_name === undefined) {
        throw new ToolInputError(
          "Provide `channel_id` or `channel_name` for the public channel to join.",
        );
      }

      const target = await resolveSlackChannelTarget({
        channelId: channel_id,
        channelName: channel_name,
        nameResolver: deps.nameResolver,
      });

      const access = await checkSlackChannelReadAccess({
        currentChannelIds: [
          context.destinationChannelId,
          context.sourceChannelId,
        ],
        conversationInfo: deps.conversationInfo,
        store: deps.visibilityStore,
        targetChannelId: target.channelId,
        teamId: context.teamId,
      });
      if (!access.allowed) {
        throw new ToolInputError(access.error);
      }
      if (access.isMember === true) {
        return {
          channel_id: target.channelId,
          ...(access.channelName || target.channelName
            ? { channel_name: access.channelName ?? target.channelName }
            : {}),
          joined: false,
          already_member: true,
        };
      }

      const joinChannel =
        deps.joinChannel ??
        ({
          joinPublicChannel,
        } satisfies SlackChannelJoinWriter);

      try {
        await joinChannel.joinPublicChannel(target.channelId);
      } catch (error) {
        if (error instanceof SlackActionError) {
          if (error.code === "missing_scope") {
            throw new ToolInputError(
              "Cannot join this public Slack channel because this installation is missing the `channels:join` scope.",
              { cause: error },
            );
          }
          throw new ToolInputError(
            "Could not join this public Slack channel. Confirm it is public and retry, or ask an admin to add the bot.",
            { cause: error },
          );
        }
        throw error;
      }

      return {
        channel_id: target.channelId,
        ...(access.channelName || target.channelName
          ? { channel_name: access.channelName ?? target.channelName }
          : {}),
        joined: true,
        already_member: false,
      };
    },
  });
}
