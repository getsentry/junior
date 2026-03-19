import { Type } from "@sinclair/typebox";
import { normalizeSlackEmojiName } from "@/chat/slack-actions/emoji";
import { addReactionToMessage } from "@/chat/slack-actions/channel";
import { tool } from "@/chat/tools/definition";
import { createOperationKey } from "@/chat/tools/idempotency";
import type { ToolRuntimeContext, ToolState } from "@/chat/tools/types";

export function createSlackMessageAddReactionTool(
  context: ToolRuntimeContext,
  state: ToolState,
) {
  return tool({
    description:
      "Add an emoji reaction to the current inbound Slack message. Use sparingly for lightweight acknowledgements. Provide a Slack emoji alias name (for example `thumbsup`, `white_check_mark`, or `thumbsup::skin-tone-6`), not a unicode emoji glyph. The target message is injected by runtime context; do not use this for arbitrary historical messages.",
    inputSchema: Type.Object({
      emoji: Type.String({
        minLength: 1,
        maxLength: 64,
        description:
          "Slack emoji alias name to react with (for example `thumbsup`, `white_check_mark`, or `thumbsup::skin-tone-6`). Optional surrounding colons are allowed.",
      }),
    }),
    execute: async ({ emoji }) => {
      const targetChannelId = context.channelId;
      if (!targetChannelId) {
        return {
          ok: false,
          error: "No active channel context is available for reactions",
        };
      }
      const targetMessageTs = context.messageTs;
      if (!targetMessageTs) {
        return {
          ok: false,
          error: "No active message timestamp is available for reactions",
        };
      }
      const normalizedEmoji = normalizeSlackEmojiName(emoji);
      if (!normalizedEmoji) {
        return {
          ok: false,
          error:
            "Emoji must be a valid Slack emoji alias name (for example `thumbsup` or `thumbsup::skin-tone-6`)",
        };
      }

      const operationKey = createOperationKey("slackMessageAddReaction", {
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
