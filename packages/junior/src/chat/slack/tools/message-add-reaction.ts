import { Type } from "@sinclair/typebox";
import { normalizeSlackEmojiName } from "@/chat/slack/emoji";
import { addReactionToMessage } from "@/chat/slack/outbound";
import { tool } from "@/chat/tools/definition";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import { createOperationKey } from "@/chat/tools/idempotency";
import type { SlackToolContext } from "@/chat/slack/tools/context";
import type { ToolState } from "@/chat/tools/types";

/** Create the tool that reacts to the current inbound Slack message. */
export function createSlackMessageAddReactionTool(
  context: SlackToolContext,
  state: ToolState,
) {
  return tool({
    description:
      "Add an emoji reaction to the current inbound Slack message. Use when the user asks for a reaction on the current message without another target. Provide a Slack emoji alias name (for example `thumbsup`, `white_check_mark`, or `thumbsup::skin-tone-6`), not a unicode emoji glyph. The target message is injected by runtime context; do not use this for arbitrary historical messages.",
    inputSchema: Type.Object({
      emoji: Type.String({
        minLength: 1,
        maxLength: 64,
        description:
          "Slack emoji alias name to react with (for example `thumbsup`, `white_check_mark`, or `thumbsup::skin-tone-6`). Optional surrounding colons are allowed.",
      }),
    }),
    execute: async ({ emoji }) => {
      const targetChannelId = context.sourceChannelId;
      const targetMessageTs = context.messageTs;
      if (!targetMessageTs) {
        throw new ToolInputError(
          "No active message timestamp is available for reactions.",
        );
      }
      const normalizedEmoji = normalizeSlackEmojiName(emoji);
      if (!normalizedEmoji) {
        throw new ToolInputError(
          "Emoji must be a valid Slack emoji alias name (for example `thumbsup` or `thumbsup::skin-tone-6`).",
        );
      }

      const operationKey = createOperationKey("addReaction", {
        channel_id: targetChannelId,
        message_ts: targetMessageTs,
        emoji: normalizedEmoji,
      });
      const cached = state.getOperationResult<{
        ok: true;
        channel_id: string;
        message_ts: string;
        emoji: string;
      }>(operationKey);
      if (cached) {
        return {
          ...cached,
          deduplicated: true,
        };
      }

      await addReactionToMessage({
        channelId: targetChannelId,
        timestamp: targetMessageTs,
        emoji: normalizedEmoji,
      });
      const response = {
        ok: true,
        channel_id: targetChannelId,
        message_ts: targetMessageTs,
        emoji: normalizedEmoji,
      };
      state.setOperationResult(operationKey, response);
      return response;
    },
  });
}
