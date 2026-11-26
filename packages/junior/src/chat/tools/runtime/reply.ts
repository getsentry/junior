import * as z from "zod";
import { isLegacyNoReplyMarker, NO_REPLY_TOOL_NAME } from "@/chat/no-reply";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool, zodToolDefinition } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tool-support/tool-input-error";
import { replyTextSchema } from "@/chat/turn-answer";

const DESCRIPTIONS = {
  automation: {
    tool: "Post the Automation's reply. The run's first reply goes to every place the Automation posts to, such as its channel or the creator's DMs. Later replies go in the Slack thread of the first reply in the Automation's channel.",
    text: "The finished message, such as a reminder, digest, or alert.",
  },
  lead: {
    tool: "Post a message to the Space's members. This Turn's final text is not delivered, so this is the only way to tell them something in it.",
    text: "The message, such as a result they asked for, or a decision that only they can make.",
  },
} as const;

/** Static definition of `reply` for one place that it posts to. */
export function replyToolDefinition(target: "automation" | "lead") {
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
 * Create the tool that sets the reply of a gated Turn. The runtime posts it
 * after the Turn ends: `automation` to the run's Destination or Slack
 * thread, `lead` to the Lead's transcript.
 */
export function createReplyTool(target: "automation" | "lead") {
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
        throw new ToolInputError(
          `The reply text must not be empty. Set text to the reply, or call \`${NO_REPLY_TOOL_NAME}\` to post nothing.`,
        );
      }
      return { text: text.data };
    },
  });
}
