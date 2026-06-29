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
      "Post a new top-level message in the active Slack channel, outside the current thread. Use this only when the user's current message explicitly asks you to post/send/share/say/announce/broadcast a message to the current channel. Do not use this for normal answers, thread replies, paraphrasing or forwarding the user's message, speculative broadcasts, or pinging a mentioned user. An inline Slack @mention in the user's message is not by itself a request to relay or ping that user; answer the user in the thread instead. For requests targeting another named channel, explain that limitation instead. Do not claim a channel message was posted unless this tool succeeds in this turn.",
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
