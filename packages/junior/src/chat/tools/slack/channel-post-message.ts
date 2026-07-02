import { Type } from "@sinclair/typebox";
import { postSlackMessage } from "@/chat/slack/outbound";
import { tool } from "@/chat/tools/definition";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import { createOperationKey } from "@/chat/tools/idempotency";
import type { SlackToolContext } from "@/chat/tools/slack/context";
import type { ToolState } from "@/chat/tools/types";

export function createSlackChannelPostMessageTool(
  context: SlackToolContext,
  state: ToolState,
) {
  return tool({
    description:
      "Post a new top-level message to the current Slack channel. Use only when the user explicitly asks to post/send/share/say something to the current channel. Do not use for other named channels, thread replies, inline @mentions, or pinging mentioned users.",
    inputSchema: Type.Object({
      text: Type.String({
        minLength: 1,
        maxLength: 40000,
        description: "Slack mrkdwn text to post.",
      }),
    }),
    execute: async ({ text }) => {
      const targetChannelId = context.destinationChannelId;
      if (!targetChannelId) {
        throw new ToolInputError("No active Slack destination is available.");
      }

      const operationKey = createOperationKey("slackChannelPostMessage", {
        channel_id: targetChannelId,
        text,
      });
      const cached = state.getOperationResult<{
        ok: true;
        channel_id: string;
        ts: string;
        permalink?: string;
      }>(operationKey);
      if (cached) {
        return {
          ...cached,
          deduplicated: true,
        };
      }

      const posted = await postSlackMessage({
        channelId: targetChannelId,
        text,
        includePermalink: true,
      });
      const response = {
        ok: true,
        channel_id: targetChannelId,
        ts: posted.ts,
        permalink: posted.permalink,
      };
      state.setOperationResult(operationKey, response);
      return response;
    },
  });
}
