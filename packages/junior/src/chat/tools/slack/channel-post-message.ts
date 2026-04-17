import { Type } from "@sinclair/typebox";
import { postSlackMessage } from "@/chat/slack/outbound";
import { tool } from "@/chat/tools/definition";
import { createOperationKey } from "@/chat/tools/idempotency";
import type { ToolRuntimeContext, ToolState } from "@/chat/tools/types";

export function createSlackChannelPostMessageTool(
  context: ToolRuntimeContext,
  state: ToolState,
) {
  return tool({
    description:
      "Post a message in the active Slack channel context (outside the thread). Use this when the user explicitly asks to post/send/share/say something in the channel. Do not use for normal thread replies or speculative broadcasts. Do not claim a channel message was posted unless this tool succeeds in this turn.",
    inputSchema: Type.Object({
      text: Type.String({
        minLength: 1,
        maxLength: 40000,
        description: "Slack mrkdwn text to post.",
      }),
    }),
    execute: async ({ text }) => {
      const targetChannelId = context.channelId;
      if (!targetChannelId) {
        return {
          ok: false,
          error: "No active channel context is available for posting",
        };
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
