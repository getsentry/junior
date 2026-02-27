import { Type } from "@sinclair/typebox";
import { postMessageToChannel } from "@/chat/slack-actions/channel";
import { tool } from "@/chat/tools/definition";
import { createOperationKey } from "@/chat/tools/idempotency";
import type { ToolRuntimeContext, ToolState } from "@/chat/tools/types";

function hasExplicitChannelPostIntent(userText: string | undefined): boolean {
  if (!userText) {
    return false;
  }

  const normalized = userText.toLowerCase();
  const mentionsChannelTarget =
    /\b(channel|main channel|public channel)\b/.test(normalized) || /(^|\s)#([a-z0-9_-]+)/.test(normalized);
  const hasPostingVerb = /\b(post|send|share|announce|broadcast|publish)\b/.test(normalized);
  return mentionsChannelTarget && hasPostingVerb;
}

export function createSlackChannelPostMessageTool(context: ToolRuntimeContext, state: ToolState) {
  return tool({
    description:
      "Post a message in a Slack channel (outside the thread). Use when the user explicitly asks to share or announce something in a channel. Do not use for normal thread replies or speculative broadcasts.",
    inputSchema: Type.Object({
      text: Type.String({
        minLength: 1,
        maxLength: 40000,
        description: "Slack mrkdwn text to post."
      }),
      channel_id: Type.Optional(
        Type.String({
          minLength: 1,
          description: "Optional destination channel ID. Defaults to the current thread channel."
        })
      )
    }),
    execute: async ({ text, channel_id }) => {
      const targetChannelId = channel_id ?? context.channelId;
      if (!targetChannelId) {
        return { ok: false, error: "No channel_id provided and no active channel context is available" };
      }

      if (!hasExplicitChannelPostIntent(context.userText)) {
        return {
          ok: false,
          error: "Blocked: posting to a channel requires explicit user intent to post/share in-channel in this turn"
        };
      }

      const operationKey = createOperationKey("slackChannelPostMessage", {
        channel_id: targetChannelId,
        text
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
          deduplicated: true
        };
      }

      const posted = await postMessageToChannel({
        channelId: targetChannelId,
        text
      });
      const response = {
        ok: true,
        channel_id: targetChannelId,
        ts: posted.ts,
        permalink: posted.permalink
      };
      state.setOperationResult(operationKey, response);
      return response;
    }
  });
}
