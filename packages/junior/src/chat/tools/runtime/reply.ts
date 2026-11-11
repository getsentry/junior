import * as z from "zod";
import { isLegacyNoReplyMarker, NO_REPLY_TOOL_NAME } from "@/chat/no-reply";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import { replyTextSchema } from "@/chat/turn-answer";

/**
 * Create the tool that declares the reply of one gated Turn. The runtime posts
 * the reply after the Turn ends.
 */
export function createReplyTool() {
  let replied = false;
  return zodTool({
    annotations: {
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
      readOnlyHint: false,
    },
    description:
      "Post the reply of this Turn when the Turn ends. The first reply of an Automation run goes to its stored destinations; later replies go to the run's Slack thread. One reply per Turn.",
    exposure: "modelOnly",
    inputSchema: z
      .object({
        text: z
          .string()
          .describe(
            "The finished message, such as a reminder, digest, alert, or answer.",
          ),
      })
      .strict(),
    outputSchema: juniorToolOutputSchema.extend({ text: z.string() }),
    execute: async (input) => {
      if (replied) {
        throw new ToolInputError("This Turn already has a reply.");
      }
      if (isLegacyNoReplyMarker(input.text)) {
        throw new ToolInputError(
          `To post nothing, call \`${NO_REPLY_TOOL_NAME}\` instead.`,
        );
      }
      const text = replyTextSchema.safeParse(input.text);
      if (!text.success) {
        throw new ToolInputError("The reply text must not be empty.");
      }
      replied = true;
      return { text: text.data };
    },
  });
}
