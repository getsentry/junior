import * as z from "zod";
import { isLegacyNoReplyMarker, NO_REPLY_TOOL_NAME } from "@/chat/no-reply";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import { replyTextSchema } from "@/chat/turn-answer";

/**
 * Create the tool that sets the reply of one gated Turn. The runtime posts the
 * reply after the Turn ends.
 */
export function createReplyTool() {
  return zodTool({
    annotations: {
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
      readOnlyHint: false,
    },
    description:
      "Post the reply of this Turn when the Turn ends. When the run starts, the reply goes to its stored destinations. After the run posts, a reply goes to the run's Slack thread.",
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
    execute: async (input) => {
      if (isLegacyNoReplyMarker(input.text)) {
        throw new ToolInputError(
          `To post nothing, call \`${NO_REPLY_TOOL_NAME}\` instead.`,
        );
      }
      const text = replyTextSchema.safeParse(input.text);
      if (!text.success) {
        throw new ToolInputError("The reply text must not be empty.");
      }
      return { text: text.data };
    },
  });
}
