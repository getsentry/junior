import { joinPublicChannel } from "@/chat/slack/channel";
import { SlackActionError } from "@/chat/slack/client";
import { checkSlackChannelReadAccess } from "@/chat/slack/tool-support/channel-access";
import {
  resolveSlackChannelRef,
  slackChannelRefParam,
} from "@/chat/slack/tool-support/channel-target";
import type { SlackToolContext } from "@/chat/slack/tool-support/context";
import { z } from "zod";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";

/** Create a tool that joins one public Slack channel. */
export function createSlackChannelJoinTool(context: SlackToolContext) {
  return zodTool({
    description: "Join a public Slack channel.",
    annotations: {
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
      readOnlyHint: false,
    },
    inputSchema: z.object({
      channel_id: slackChannelRefParam,
    }),
    outputSchema: juniorToolOutputSchema,
    execute: async ({ channel_id }) => {
      const target = await resolveSlackChannelRef({
        field: "channel_id",
        value: channel_id,
        teamId: context.teamId,
      });

      const access = await checkSlackChannelReadAccess({
        currentChannelIds: [
          context.destinationChannelId,
          context.sourceChannelId,
        ],
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
            : undefined),
          joined: false,
          already_member: true,
        };
      }

      try {
        await joinPublicChannel(target.channelId);
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
          : undefined),
        joined: true,
        already_member: false,
      };
    },
  });
}
