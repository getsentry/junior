import { z } from "zod";
import {
  buildSlackButtonMessage,
  SLACK_BUTTON_LIMITS,
} from "@/chat/slack/buttons";
import { postSlackMessage } from "@/chat/slack/outbound";
import type { SlackToolContext } from "@/chat/slack/tool-support/context";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import { createOperationKey } from "@/chat/tools/idempotency";
import type { ToolState } from "@/chat/tools/types";

const buttonSchema = z.object({
  label: z
    .string()
    .trim()
    .min(1)
    .max(SLACK_BUTTON_LIMITS.maxLabelChars)
    .describe("Short button text shown to people."),
  value: z
    .string()
    .trim()
    .min(1)
    .max(SLACK_BUTTON_LIMITS.maxValueChars)
    .describe(
      "What this choice means. It comes back to you in the click message, so make it specific enough to act on.",
    ),
  style: z
    .enum(["primary", "danger"])
    .optional()
    .describe(
      "Optional color. Use `primary` for the main choice and `danger` for destructive choices.",
    ),
});

/** Create the tool that posts a message with buttons to the active Slack thread. */
export function createSlackMessagePostButtonsTool(
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
    description:
      "Post a message with clickable buttons to the active Slack thread. Use it when people should choose between a few clear options, such as approve or cancel. A click starts a new turn in this thread from the person who clicked, with the button label and value. The first click answers the message and removes the buttons. Do not repeat the buttons in your reply.",
    inputSchema: z.object({
      text: z
        .string()
        .trim()
        .min(1)
        .max(SLACK_BUTTON_LIMITS.maxTextChars)
        .describe("Slack markdown shown above the buttons."),
      buttons: z
        .array(buttonSchema)
        .min(1)
        .max(SLACK_BUTTON_LIMITS.maxButtons)
        .describe("Buttons in display order."),
    }),
    outputSchema: juniorToolOutputSchema,
    execute: async ({ buttons, text }) => {
      const channelId = context.locationChannelId;
      const threadTs = context.threadTs ?? context.messageTs;
      if (!threadTs) {
        throw new ToolInputError(
          "No active Slack thread is available for buttons.",
        );
      }
      const labels = buttons.map((button) => button.label);
      if (new Set(labels).size !== labels.length) {
        throw new ToolInputError("Each button needs a different label.");
      }

      const operationKey = createOperationKey("slackButtonsPost", {
        buttons,
        channel_id: channelId,
        text,
        thread_ts: threadTs,
      });
      const cached = state.getOperationResult<{
        channel_id: string;
        message_ts: string;
      }>(operationKey);
      if (cached) {
        return { ...cached, deduplicated: true };
      }

      const message = buildSlackButtonMessage({ buttons, text });
      const posted = await postSlackMessage({
        blocks: message.blocks,
        channelId,
        text: message.text,
        threadTs,
      });
      const response = { channel_id: channelId, message_ts: posted.ts };
      state.setOperationResult(operationKey, response);
      return response;
    },
  });
}
