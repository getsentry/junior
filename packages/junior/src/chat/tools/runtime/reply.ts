import * as z from "zod";
import { isLegacyNoReplyMarker, NO_REPLY_TOOL_NAME } from "@/chat/no-reply";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool, zodToolDefinition } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tool-support/tool-input-error";
import { replyTextSchema } from "@/chat/turn-answer";

const DESCRIPTIONS = {
  parent: {
    tool: "Send the reply of this Turn to your parent agent when the Turn ends. The parent reads it as your result.",
    text: "The finished result for your parent agent, with everything it needs to continue.",
  },
  automation: {
    tool: "Post the Automation's reply. The run's first reply goes to every place the Automation posts to, such as its channel or the creator's DMs. Later replies go in the Slack thread of the first reply in the Automation's channel.",
    text: "The finished message, such as a reminder, digest, or alert.",
  },
} as const;

/** Static definition of `reply` for one reply target. */
export function replyToolDefinition(target: "parent" | "automation") {
  const descriptions = DESCRIPTIONS[target];
  return zodToolDefinition({
    annotations: {
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
      readOnlyHint: false,
    },
    description: descriptions.tool,
    exposure: "modelOnly",
    inputSchema: z
      .object({
        text: z.string().describe(descriptions.text),
      })
      .strict(),
    outputSchema: juniorToolOutputSchema.extend({ text: z.string() }),
  });
}

/**
 * Create the tool that sets the reply of one gated Turn. The runtime sends
 * the reply after the Turn ends. `parent`: to the parent agent's inbox.
 * `automation`: to the Automation run's Destination or Slack thread.
 */
export function createReplyTool(target: "parent" | "automation") {
  return zodTool({
    ...replyToolDefinition(target),
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
