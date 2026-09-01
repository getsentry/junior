import { normalizeSlackEmojiName } from "@/chat/slack/emoji";
import { addReactionToMessage } from "@/chat/slack/outbound";
import { z } from "zod";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import { createOperationKey } from "@/chat/tools/idempotency";
import type { SlackToolContext } from "@/chat/slack/tool-support/context";
import type { ToolState } from "@/chat/tools/types";

/** Create the tool that reacts to the current inbound Slack message. */
export function createSlackMessageAddReactionTool(
  context: SlackToolContext,
  state: ToolState,
) {
  return zodTool({
    approvalMode: "approve",
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: false,
    },
    description: "Add an emoji reaction to the current inbound Slack message.",
    inputSchema: z.object({
      emoji: z
        .string()
        .min(1)
        .max(64)
        .describe(
          "Slack emoji alias name to react with (for example `thumbsup`, `white_check_mark`, or `thumbsup::skin-tone-6`). Optional surrounding colons are allowed.",
        ),
    }),
    outputSchema: juniorToolOutputSchema,
    execute: async ({ emoji }) => {
      const targetChannelId = context.messageChannelId;
      const targetMessageTs = context.messageTs;
      if (!targetChannelId || !targetMessageTs) {
        throw new ToolInputError(
          "No active Slack message is available for reactions.",
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
        channel_id: targetChannelId,
        message_ts: targetMessageTs,
        emoji: normalizedEmoji,
      };
      state.setOperationResult(operationKey, response);
      return response;
    },
  });
}
