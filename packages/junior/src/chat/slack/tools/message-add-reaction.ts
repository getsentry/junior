import { NO_REPLY_TOOL_NAME } from "@/chat/no-reply";
import { normalizeSlackEmojiName } from "@/chat/slack/emoji";
import { addReactionToMessage } from "@/chat/slack/outbound";
import * as z from "zod";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import { createOperationKey } from "@/chat/tools/idempotency";
import type { SlackToolContext } from "@/chat/slack/tool-support/context";
import type { ToolState } from "@/chat/tools/types";
import { SLACK_TOOL_SOURCE } from "@/chat/slack/tool-support/tool-source";

/**
 * Create the tool that reacts to the current inbound Slack message or to the
 * root message of the Conversation's thread.
 *
 * @runBuilt addReaction
 */
export function createSlackMessageAddReactionTool(
  context: SlackToolContext,
  state: ToolState,
) {
  return zodTool({
    exposure: "deferred",
    source: SLACK_TOOL_SOURCE,
    approvalMode: "approve",
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: false,
    },
    // The system prompt owns the no-reply protocol. This names when a
    // reaction is the whole reply, as `addReviewItem` does for its card.
    description: `Add an emoji reaction to the current inbound Slack message or to the root message of the Conversation's thread. When the reaction is the whole reply, do not report it in text: end the Turn with \`${NO_REPLY_TOOL_NAME}\`.`,
    inputSchema: z.object({
      emoji: z
        .string()
        .min(1)
        .max(64)
        .describe(
          "Slack emoji alias name to react with (for example `thumbsup`, `white_check_mark`, or `thumbsup::skin-tone-6`). Optional surrounding colons are allowed.",
        ),
      message: z
        .enum(["inbound", "thread_root"])
        .nullable()
        .optional()
        .describe(
          "Message to react to: `inbound` (default; null means omitted) is the message that started this Turn. `thread_root` is the root message of this Conversation's thread, for example to mark the thread in an Event Turn.",
        ),
    }),
    outputSchema: juniorToolOutputSchema,
    execute: async ({ emoji, message }) => {
      // Both targets stay inside the current Conversation.
      const targetsThreadRoot = message === "thread_root";
      const targetChannelId = targetsThreadRoot
        ? context.locationChannelId
        : context.messageChannelId;
      const targetMessageTs = targetsThreadRoot
        ? context.threadTs
        : context.messageTs;
      if (!targetChannelId || !targetMessageTs) {
        throw new ToolInputError(
          targetsThreadRoot
            ? "This Conversation has no Slack thread to react to."
            : "This Turn has no inbound Slack message. Use `message: thread_root` to react to the thread root.",
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
