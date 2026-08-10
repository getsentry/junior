import {
  resolvePublicChannelByName,
  type SlackPublicChannelSummary,
} from "@/chat/slack/channel";
import { SlackActionError } from "@/chat/slack/client";
import { z } from "zod";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";

export interface SlackChannelResolveDeps {
  resolvePublicChannelByName?: typeof resolvePublicChannelByName;
}

function toOutput(channel: SlackPublicChannelSummary) {
  return {
    channel_id: channel.id,
    ...(channel.name ? { channel_name: channel.name } : {}),
    ...(typeof channel.isMember === "boolean"
      ? { is_member: channel.isMember }
      : {}),
  };
}

/** Create a tool that resolves public Slack channel names to channel ids. */
export function createSlackChannelResolveTool(
  deps: SlackChannelResolveDeps = {},
) {
  return zodTool({
    description:
      "Resolve a public Slack channel name (for example `#proj-foo` or `proj-foo`) to a channel id. Use before channel history, join, or thread reads when the user names a channel instead of giving a C… id. This only resolves public channels.",
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: true,
    },
    inputSchema: z.object({
      channel_name: z
        .string()
        .trim()
        .min(1)
        .max(80)
        .describe("Public channel name with or without a leading #."),
    }),
    outputSchema: juniorToolOutputSchema,
    execute: async ({ channel_name }) => {
      const resolve =
        deps.resolvePublicChannelByName ?? resolvePublicChannelByName;
      try {
        const match = await resolve(channel_name);
        if (!match) {
          throw new ToolInputError(
            `No public Slack channel named \`${channel_name}\` was found.`,
          );
        }
        return {
          count: 1,
          channel: toOutput(match),
        };
      } catch (error) {
        if (error instanceof ToolInputError) {
          throw error;
        }
        if (error instanceof SlackActionError) {
          if (error.code === "missing_scope") {
            throw new ToolInputError(
              "Cannot resolve Slack channel names because this installation is missing channel read scopes.",
              { cause: error },
            );
          }
          throw new ToolInputError(
            "Could not resolve that Slack channel name.",
            { cause: error },
          );
        }
        throw error;
      }
    },
  });
}
