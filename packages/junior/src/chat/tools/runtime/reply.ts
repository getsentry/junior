import * as z from "zod";
import { isLegacyNoReplyMarker, NO_REPLY_TOOL_NAME } from "@/chat/no-reply";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool, zodToolDefinition } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tool-support/tool-input-error";
import { replyTextSchema } from "@/chat/turn-answer";

/** Static definition of `reply`, the answer that posts an Automation run. */
export const replyToolDefinition = zodToolDefinition({
  annotations: {
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
    readOnlyHint: false,
  },
  description:
    "Post the Automation's reply. The run's first reply goes to every place the Automation posts to, such as its channel or the creator's DMs. Later replies go in the Slack thread of the first reply in the Automation's channel.",
  exposure: "modelOnly",
  inputSchema: z
    .object({
      text: z
        .string()
        .describe(
          "The finished message, such as a reminder, digest, or alert.",
        ),
    })
    .strict(),
  outputSchema: juniorToolOutputSchema.extend({ text: z.string() }),
});

/**
 * Create the tool that sets the reply of an Automation run's Turn. The
 * runtime posts it to the run's Destination or Slack thread after the Turn
 * ends.
 */
export function createReplyTool() {
  return zodTool({
    ...replyToolDefinition,
    execute: async (input) => {
      if (isLegacyNoReplyMarker(input.text)) {
        throw new ToolInputError(
          `To post nothing, call \`${NO_REPLY_TOOL_NAME}\` instead.`,
        );
      }
      const text = replyTextSchema.safeParse(input.text);
      if (!text.success) {
        throw new ToolInputError(
          `The reply text must not be empty. Set text to the reply, or call \`${NO_REPLY_TOOL_NAME}\` to post nothing.`,
        );
      }
      return { text: text.data };
    },
  });
}
